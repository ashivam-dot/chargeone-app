// A D1 stand-in on Node's built-in SQLite, with the real migrations applied, so tests run
// the actual SQL. SQLite binds ?N to the Nth argument, the same as D1.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../env.ts';

type Value = string | number | null;

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Value[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.db, this.sql, params.map((p) => (p === undefined ? null : (p as Value))));
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: object }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }

  async run(): Promise<{ results: []; success: true; meta: { changes: number; last_row_id: number } }> {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

/** Migrations contain no semicolons inside literals, so splitting on ';' is safe here. */
function applyMigrations(db: DatabaseSync): void {
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) {
    for (const sql of readFileSync(new URL(file, dir), 'utf8').split(';')) {
      if (sql.trim()) db.prepare(sql).run();
    }
  }
}

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  return {
    sqlite: db,
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (stmts: Statement[]) => {
      db.prepare('BEGIN').run();
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.prepare('COMMIT').run();
        return out;
      } catch (err) {
        db.prepare('ROLLBACK').run();
        throw err;
      }
    },
  };
}

export function fakeEnv(overrides: Partial<Env> = {}) {
  const d1 = fakeD1();
  const stations = readFileSync(new URL('../../public/data/stations.json', import.meta.url), 'utf8');
  const env = {
    DB: d1,
    ASSETS: {
      fetch: async (input: Request | string) => {
        const path = new URL(typeof input === 'string' ? input : input.url, 'http://x').pathname;
        return path === '/data/stations.json' ? new Response(stations) : new Response('not found', { status: 404 });
      },
    },
    ENVIRONMENT: 'development',
    GOOGLE_CLIENT_ID: '',
    SESSION_SECRET: 'test-session-secret-'.padEnd(48, 'x'),
    RAZORPAY_KEY_ID: 'rzp_test_local',
    RAZORPAY_KEY_SECRET: 'local-key-secret',
    RAZORPAY_WEBHOOK_SECRET: 'local-webhook-secret',
    RAZORPAY_PLAN_MONTHLY: 'plan_monthly_local',
    RAZORPAY_PLAN_YEARLY: 'plan_yearly_local',
    ...overrides,
  } as unknown as Env;
  return { env, sqlite: d1.sqlite };
}

/**
 * Small client that keeps the session cookie between calls, like a browser. `defaults` are sent
 * with every call (for example the device header); non-JSON bodies come back in `text`.
 */
export function client(worker: { fetch: (req: Request, env: Env) => Promise<Response> }, env: Env, defaults: Record<string, string> = {}) {
  const origin = 'https://chargeone.test';
  // One value per cookie name (the session and the admin console's), dropped when cleared.
  const jar = new Map<string, string>();
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { Origin: origin, ...defaults, ...headers };
    if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (jar.size && !h.Cookie) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const res = await worker.fetch(new Request(`${origin}${path}`, { method, headers: h, body: payload }), env);
    const set = res.headers.get('Set-Cookie');
    if (set) {
      const [name, ...rest] = set.split(';')[0].split('=');
      const value = rest.join('=');
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    const text = await res.text();
    const isJson = (res.headers.get('Content-Type') ?? '').includes('application/json');
    return { status: res.status, body: (isJson ? JSON.parse(text) : {}) as Record<string, any>, text, headers: res.headers };
  };
}

export const DEVICE = '0b5e3a8e-6a43-4c7e-9a51-2f4f1c9d7e01';
export const deviceHeaders = (id = DEVICE, ip = '203.0.113.7') => ({ 'X-ChargeOne-Device': id, 'CF-Connecting-IP': ip });
