import { PLANS, isPlus, type PlanId } from '../src/shared/plans.ts';
import type { User } from './auth.ts';
import { assertCanBuy, parsePlan } from './billing.ts';
import { constantTimeEqual } from './crypto.ts';
import { getEntitlement, grantStatement } from './entitlements.ts';
import type { Env } from './env.ts';
import { HttpError, clientKey, enforceRateLimit, readJson, str } from './http.ts';

const DAY_MS = 86400_000;
/** Access while the owner checks a claimed payment against the bank statement. */
export const UPI_PROVISIONAL_MS = 2 * DAY_MS;
/** An unclaimed payment request is reused for this long instead of creating another one. */
const REUSE_MS = 3600_000;
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const UTR = /^\d{12}$/;
const REF = /^CO[A-Z2-9]{10}$/;

interface UpiRow {
  ref: string;
  user_id: string;
  plan: PlanId;
  amount_paise: number;
  utr: string | null;
  status: 'created' | 'claimed' | 'confirmed' | 'rejected';
  created_at: string;
  claimed_at: string | null;
  decided_at: string | null;
}

function upiConfig(env: Env): { vpa: string; name: string } {
  const vpa = env.UPI_VPA?.trim();
  if (!vpa || !/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/.test(vpa)) {
    throw new HttpError(503, 'payments_not_configured', 'UPI payments are not set up yet.');
  }
  return { vpa, name: env.UPI_PAYEE_NAME?.trim() || 'ChargeOne' };
}

export const upiEnabled = (env: Env): boolean => {
  try {
    upiConfig(env);
    return true;
  } catch {
    return false;
  }
};

function newRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `CO${[...bytes].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('')}`;
}

/** The standard UPI deep link (NPCI linking spec). Every UPI app opens it with the amount and note filled in. */
export function upiUri(vpa: string, name: string, amountPaise: number, note: string): string {
  const q = new URLSearchParams({ pa: vpa, pn: name, am: (amountPaise / 100).toFixed(2), cu: 'INR', tn: note });
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
}

function present(env: Env, row: UpiRow) {
  const { vpa, name } = upiConfig(env);
  const note = `ChargeOne ${PLANS[row.plan].name} ${row.ref}`;
  return {
    ref: row.ref,
    plan: row.plan,
    amountPaise: row.amount_paise,
    payee: vpa,
    payeeName: name,
    note,
    uri: upiUri(vpa, name, row.amount_paise, note),
    status: row.status,
  };
}

export async function createUpiPayment(req: Request, env: Env, user: User) {
  upiConfig(env);
  const plan = parsePlan(await readJson(req, 1024));
  await enforceRateLimit(env.DB, `upi:${user.id}`, 10, 3600);
  const now = new Date();
  await assertCanBuy(env, user, plan, now, true);

  const recent = await env.DB.prepare(
    "SELECT * FROM upi_payments WHERE user_id = ?1 AND plan = ?2 AND status = 'created' AND created_at > ?3 ORDER BY created_at DESC LIMIT 1",
  )
    .bind(user.id, plan, new Date(now.getTime() - REUSE_MS).toISOString())
    .first<UpiRow>();
  if (recent) return present(env, recent);

  const row: UpiRow = {
    ref: newRef(),
    user_id: user.id,
    plan,
    amount_paise: PLANS[plan].pricePaise,
    utr: null,
    status: 'created',
    created_at: now.toISOString(),
    claimed_at: null,
    decided_at: null,
  };
  await env.DB.prepare('INSERT INTO upi_payments (ref, user_id, plan, amount_paise, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(row.ref, row.user_id, row.plan, row.amount_paise, row.status, row.created_at)
    .run();
  return present(env, row);
}

/**
 * The payer enters the 12-digit UPI transaction id after paying. Access starts at once for a short
 * while, but only for someone with no rejected claim and no other claim waiting, so a made-up
 * number buys two days once at most.
 */
export async function claimUpiPayment(req: Request, env: Env, user: User) {
  const body = await readJson(req, 1024);
  const ref = str(body, 'ref', { max: 12, pattern: REF })!;
  const utr = str(body, 'utr', { max: 12, pattern: UTR })!;
  await enforceRateLimit(env.DB, `upi-claim:${user.id}`, 8, 3600);

  const row = await env.DB.prepare('SELECT * FROM upi_payments WHERE ref = ?1').bind(ref).first<UpiRow>();
  if (!row || row.user_id !== user.id) throw new HttpError(404, 'unknown_payment', 'Payment not found for this account.');
  if (row.status !== 'created') {
    if (row.utr === utr) return { status: row.status, provisional: false };
    throw new HttpError(409, 'already_claimed', 'This payment already has a transaction id.');
  }
  const used = await env.DB.prepare('SELECT ref FROM upi_payments WHERE utr = ?1').bind(utr).first();
  if (used) throw new HttpError(409, 'utr_used', 'That transaction id has already been used.');

  const now = new Date();
  const history = await env.DB.prepare(
    "SELECT SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected, SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS waiting FROM upi_payments WHERE user_id = ?1",
  )
    .bind(user.id)
    .first<{ rejected: number | null; waiting: number | null }>();
  // Never cut short access the user already has (a trial, or prepaid Plus being renewed early).
  const e = await getEntitlement(env, user.id);
  const hasLonger = Boolean(e?.activeUntil && new Date(e.activeUntil).getTime() >= now.getTime() + UPI_PROVISIONAL_MS);
  const provisional = !history?.rejected && !history?.waiting && !hasLonger;

  const claim = env.DB.prepare("UPDATE upi_payments SET status = 'claimed', utr = ?1, claimed_at = ?2 WHERE ref = ?3 AND status = 'created'").bind(
    utr,
    now.toISOString(),
    ref,
  );
  const statements = [claim];
  if (provisional) {
    statements.push(
      grantStatement(
        env,
        {
          userId: user.id,
          plan: row.plan,
          activeUntil: new Date(now.getTime() + UPI_PROVISIONAL_MS),
          source: 'upi',
          externalId: ref,
          status: 'pending',
          periodStart: row.plan === 'trip_pass' ? now : null,
        },
        { notOverPlus: row.plan === 'trip_pass' },
      ),
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) throw new HttpError(409, 'utr_used', 'That transaction id has already been used.');
    throw err;
  }
  return { status: 'claimed', provisional };
}

/** The owner's tools: list claims and confirm or reject them. Guarded by ADMIN_TOKEN, sent as a bearer token. */
export async function requireAdmin(req: Request, env: Env): Promise<void> {
  const token = env.ADMIN_TOKEN;
  if (!token || token.length < 24) throw new HttpError(404, 'not_found', 'Not found.');
  const sent = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!sent || !constantTimeEqual(sent, token)) {
    await enforceRateLimit(env.DB, `admin-fail:${await clientKey(req)}`, 10, 3600);
    throw new HttpError(401, 'unauthorized', 'Unauthorized.');
  }
}

export async function listUpiPayments(env: Env, status: string) {
  const wanted = ['created', 'claimed', 'confirmed', 'rejected'].includes(status) ? status : 'claimed';
  const { results } = await env.DB.prepare(
    `SELECT p.ref, p.plan, p.amount_paise, p.utr, p.status, p.created_at, p.claimed_at, p.decided_at, u.email
     FROM upi_payments p JOIN users u ON u.id = p.user_id WHERE p.status = ?1 ORDER BY COALESCE(p.claimed_at, p.created_at) DESC LIMIT 200`,
  )
    .bind(wanted)
    .all();
  return { payments: results };
}

export async function decideUpiPayment(env: Env, ref: string, decision: 'confirm' | 'reject') {
  if (!REF.test(ref)) throw new HttpError(400, 'invalid', 'Invalid reference.');
  const row = await env.DB.prepare('SELECT * FROM upi_payments WHERE ref = ?1').bind(ref).first<UpiRow>();
  if (!row) throw new HttpError(404, 'unknown_payment', 'Payment not found.');
  if (row.status !== 'claimed') throw new HttpError(409, 'not_claimed', `This payment is ${row.status}, not waiting for a decision.`);
  const now = new Date();

  if (decision === 'reject') {
    await env.DB.batch([
      env.DB.prepare("UPDATE upi_payments SET status = 'rejected', decided_at = ?1 WHERE ref = ?2").bind(now.toISOString(), ref),
      env.DB.prepare("UPDATE entitlements SET status = 'rejected', active_until = ?1, updated_at = ?1 WHERE user_id = ?2 AND external_id = ?3")
        .bind(now.toISOString(), row.user_id, ref),
    ]);
    return { ref, status: 'rejected' };
  }

  // The paid period starts when the payment is confirmed, so time spent waiting isn't lost. An
  // early renewal of prepaid Plus adds to the time left instead.
  const plan = PLANS[row.plan];
  const e = await getEntitlement(env, row.user_id);
  const carriesOver = e?.source === 'trial' || (e?.source === 'upi' && e.status === 'active' && e.externalId !== ref);
  const left = e && isPlus(row.plan) && isPlus(e.plan) && carriesOver && e.activeUntil ? new Date(e.activeUntil).getTime() : 0;
  const from = Math.max(now.getTime(), left);
  await env.DB.batch([
    env.DB.prepare("UPDATE upi_payments SET status = 'confirmed', decided_at = ?1 WHERE ref = ?2").bind(now.toISOString(), ref),
    env.DB.prepare('INSERT INTO payments (id, user_id, plan, checkout_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO NOTHING').bind(
      `upi_${row.utr}`,
      row.user_id,
      row.plan,
      ref,
      now.toISOString(),
    ),
    grantStatement(env, {
      userId: row.user_id,
      plan: row.plan,
      activeUntil: new Date(from + plan.periodDays * DAY_MS),
      source: 'upi',
      externalId: ref,
      status: 'active',
      periodStart: row.plan === 'trip_pass' ? now : null,
    }),
  ]);
  return { ref, status: 'confirmed' };
}
