// The admin console: sign in with ADMIN_TOKEN, then counts, integration health with live tests,
// users and plan grants, test sessions for every plan, trips, feedback, report moderation, UPI
// payments and the audit log. Sections are hash routes so a refresh keeps your place.
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { PAID_PLANS, PLANS } from '../shared/plans.ts';
import { VEHICLES, myVehicleFromModel } from '../shared/vehicles.ts';
import { ApiError, call, when } from './api.ts';

const SECTIONS = [
  ['overview', 'Overview'],
  ['test', 'Test as'],
  ['users', 'Users'],
  ['trips', 'Trips'],
  ['feedback', 'Feedback'],
  ['reports', 'Reports'],
  ['payments', 'Payments'],
  ['audit', 'Audit log'],
] as const;
type Section = (typeof SECTIONS)[number][0];

const sectionFromHash = (): Section => {
  const h = location.hash.replace(/^#/, '');
  return (SECTIONS.find(([id]) => id === h)?.[0] ?? 'overview') as Section;
};

type AuthState = 'checking' | 'signed-out' | 'signed-in' | { notConfigured: string };

export function AdminApp() {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [section, setSection] = useState<Section>(sectionFromHash);

  useEffect(() => {
    call('GET', '/api/admin/session')
      .then(() => setAuth('signed-in'))
      .catch((e: unknown) => setAuth(e instanceof ApiError && e.code === 'not_configured' ? { notConfigured: e.message } : 'signed-out'));
    const onHash = () => setSection(sectionFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  /** Any call that finds the console signed out (cookie expired, token rotated) returns to the login. */
  const onError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setAuth('signed-out');
  }, []);

  if (auth === 'checking') return <p class="ad-center" role="status">Checking access…</p>;
  if (typeof auth === 'object') {
    return (
      <main class="ad-center ad-login" data-testid="admin-not-configured">
        <h1>Admin console is off</h1>
        <p>{auth.notConfigured}</p>
      </main>
    );
  }
  if (auth === 'signed-out') return <Login onSignedIn={() => setAuth('signed-in')} />;

  const logout = async () => {
    await call('POST', '/api/admin/logout').catch(() => undefined);
    setAuth('signed-out');
  };

  return (
    <div class="ad-shell">
      <header class="ad-top">
        <strong class="ad-brand">
          ChargeOne <span>admin</span>
        </strong>
        <button type="button" class="ad-btn ad-ghost" onClick={logout} data-testid="admin-logout">
          Sign out
        </button>
      </header>
      <nav class="ad-nav" aria-label="Admin sections">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} aria-current={section === id ? 'page' : undefined} data-testid={`admin-nav-${id}`}>
            {label}
          </a>
        ))}
      </nav>
      <main class="ad-main" id="main">
        {section === 'overview' && <Overview onError={onError} />}
        {section === 'test' && <TestAs onError={onError} />}
        {section === 'users' && <Users onError={onError} />}
        {section === 'trips' && <Trips onError={onError} />}
        {section === 'feedback' && <Feedback onError={onError} />}
        {section === 'reports' && <Reports onError={onError} />}
        {section === 'payments' && <Payments onError={onError} />}
        {section === 'audit' && <Audit onError={onError} />}
      </main>
    </div>
  );
}

type SectionProps = { onError: (e: unknown) => void };

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call('POST', '/api/admin/login', { token });
      setToken('');
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="ad-center ad-login">
      <form onSubmit={submit} class="ad-card" data-testid="admin-login">
        <h1>ChargeOne admin</h1>
        <label class="ad-field">
          <span>Admin token</span>
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
            required
            maxLength={512}
            data-testid="admin-token"
          />
        </label>
        {error && (
          <p class="ad-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="ad-btn" disabled={busy || !token.trim()} data-testid="admin-login-submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p class="ad-muted">The token is the Worker secret ADMIN_TOKEN. Sessions last 12 hours.</p>
      </form>
    </main>
  );
}

/** Loads one admin GET endpoint, with reload and paging. */
function useLoad<T>(path: string | null, onError: (e: unknown) => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setError(null);
    call<T>('GET', path)
      .then((d) => live && setData(d))
      .catch((e: unknown) => {
        if (!live) return;
        onError(e);
        setError(e instanceof Error ? e.message : 'Could not load.');
      });
    return () => {
      live = false;
    };
  }, [path, tick, onError]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

function Head({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="ad-head">
      <h1>{title}</h1>
      <div class="ad-row">{children}</div>
    </div>
  );
}

function Status({ error, loading }: { error: string | null; loading: boolean }) {
  if (error)
    return (
      <p class="ad-error" role="alert">
        {error}
      </p>
    );
  return loading ? <p class="ad-muted" role="status">Loading…</p> : null;
}

function Pager({ page, count, limit, setPage }: { page: number; count: number; limit: number; setPage: (p: number) => void }) {
  return (
    <div class="ad-row ad-pager">
      <button type="button" class="ad-btn ad-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
        Previous
      </button>
      <span class="ad-muted">Page {page}</span>
      <button type="button" class="ad-btn ad-ghost" disabled={count < limit} onClick={() => setPage(page + 1)}>
        Next
      </button>
    </div>
  );
}

const TestTag = ({ on }: { on: unknown }) => (on ? <span class="ad-tag">test</span> : null);

// ---- Overview ----

interface Integration {
  id: string;
  name: string;
  configured: boolean;
  detail: string;
  missing: string[];
  howTo: string | null;
  probe: string | null;
}
interface OverviewData {
  generatedAt: string;
  environment: string;
  users: { total: number; new24h: number; new7d: number; deleted: number };
  trips: { total: number; today: number; long: number; basicToday: number; basicDevicesToday: number };
  activePlans: Array<{ plan: string; name: string; source: string; count: number }>;
  trials: { total: number; running: number };
  feedback: { total: number; last7d: number; rating7d: number | null };
  reports: { total: number; last7d: number; problems7d: number };
  upiPending: number;
  ai: { runsToday: number; budget: number; chatsToday: number };
  integrations: Integration[];
}

function Tile({ label, value, sub, id }: { label: string; value: string | number; sub?: string; id: string }) {
  return (
    <div class="ad-tile" data-testid={`tile-${id}`}>
      <span class="ad-label">{label}</span>
      <strong>{value}</strong>
      {sub && <span class="ad-muted">{sub}</span>}
    </div>
  );
}

function Overview({ onError }: SectionProps) {
  const { data, error, reload } = useLoad<OverviewData>('/api/admin/overview', onError);
  const paid = data?.activePlans.reduce((n, p) => n + p.count, 0) ?? 0;
  return (
    <section data-testid="admin-overview">
      <Head title="Overview">
        <button type="button" class="ad-btn ad-ghost" onClick={reload}>
          Refresh
        </button>
      </Head>
      <Status error={error} loading={!data} />
      {data && (
        <>
          <p class="ad-muted">
            {data.environment} · updated {when(data.generatedAt)} · test accounts are not counted
          </p>
          <div class="ad-tiles">
            <Tile id="users" label="Drivers" value={data.users.total} sub={`${data.users.new24h} new today, ${data.users.new7d} this week`} />
            <Tile id="trips" label="Trips today" value={data.trips.today + data.trips.basicToday} sub={`${data.trips.basicToday} as guests on ${data.trips.basicDevicesToday} devices`} />
            <Tile id="trips-total" label="Signed-in trips" value={data.trips.total} sub={`${data.trips.long} long trips`} />
            <Tile id="plans" label="Active paid plans" value={paid} sub={data.activePlans.map((p) => `${p.count} ${p.name} (${p.source})`).join(', ') || 'none yet'} />
            <Tile id="trials" label="Plus trials" value={data.trials.running} sub={`running, ${data.trials.total} ever`} />
            <Tile id="ai" label="Copilot runs today" value={`${data.ai.runsToday} / ${data.ai.budget}`} sub={`${data.ai.chatsToday} chat messages`} />
            <Tile id="feedback" label="Feedback this week" value={data.feedback.last7d} sub={data.feedback.rating7d === null ? 'no ratings' : `average ${data.feedback.rating7d} of 5`} />
            <Tile id="reports" label="Reports this week" value={data.reports.last7d} sub={`${data.reports.problems7d} problems`} />
            <Tile id="upi" label="UPI to check" value={data.upiPending} sub={data.upiPending ? 'see Payments' : 'nothing waiting'} />
          </div>
          <h2>Integrations</h2>
          <ul class="ad-list" data-testid="admin-integrations">
            {data.integrations.map((i) => (
              <IntegrationRow key={i.id} item={i} onError={onError} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

interface ProbeResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

function IntegrationRow({ item, onError }: { item: Integration; onError: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [plate, setPlate] = useState('');
  const [consent, setConsent] = useState(false);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const query = item.probe === 'vehicle' && plate.trim() ? `?plate=${encodeURIComponent(plate.trim())}&consent=${consent ? 1 : 0}` : '';
      setResult(await call<ProbeResult>('POST', `/api/admin/probe/${item.probe}${query}`));
    } catch (e) {
      onError(e);
      setResult({ name: item.probe ?? '', ok: false, ms: 0, detail: e instanceof Error ? e.message : 'Test failed.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class="ad-item" data-testid={`integration-${item.id}`}>
      <div class="ad-item-main">
        <span class={`ad-dot ${item.configured ? 'on' : 'off'}`} aria-hidden="true" />
        <div>
          <strong>{item.name}</strong> <span class="ad-muted">{item.configured ? 'on' : 'off'}</span>
          <p>{item.detail}</p>
          {item.missing.length > 0 && (
            <p class="ad-warn">
              Missing: <code>{item.missing.join(', ')}</code>
            </p>
          )}
          {item.howTo && <p class="ad-muted">{item.howTo}</p>}
        </div>
      </div>
      {item.probe && (
        <div class="ad-probe">
          {item.probe === 'vehicle' && (
            <div class="ad-row">
              <label class="ad-field ad-inline">
                <span>Plate (optional, one paid lookup)</span>
                <input value={plate} onInput={(e) => setPlate(e.currentTarget.value.toUpperCase())} maxLength={12} placeholder="MH12AB1234" />
              </label>
              <label class="ad-check">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.currentTarget.checked)} />
                <span>I own this car or have the owner's consent</span>
              </label>
            </div>
          )}
          <button type="button" class="ad-btn ad-ghost" onClick={run} disabled={busy} data-testid={`probe-${item.probe}`}>
            {busy ? 'Testing…' : 'Run test'}
          </button>
          {result && (
            <p class={result.ok ? 'ad-good' : 'ad-error'} role="status" data-testid={`probe-result-${item.probe}`}>
              {result.ok ? 'Passed' : 'Failed'}
              {result.ms ? ` in ${result.ms} ms` : ''}: {result.detail}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

// ---- Test as ----

const NEXON = VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!;

const TEST_OPTIONS = [
  { id: 'basic', plan: 'basic', car: false, label: 'Guest (Basic)', note: 'Signs this browser out of the app and resets today’s guest trip allowance.' },
  { id: 'free', plan: 'free', car: false, label: 'Free', note: 'A fresh signed-in driver with no plan, no trial and no trips.' },
  { id: 'trip_pass', plan: 'trip_pass', car: false, label: 'Trip Pass', note: 'A fresh driver with an active Trip Pass.' },
  { id: 'plus', plan: 'plus', car: false, label: 'Plus', note: 'A fresh driver with Plus monthly.' },
  { id: 'plus-car', plan: 'plus', car: true, label: 'Plus + demo car', note: 'Plus, with a Tata Nexon EV 45 saved as the car. Tap “Try the demo car” on the Car tab for live readings.' },
] as const;

function TestAs({ onError }: SectionProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ label: string; email: string | null; blocked: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (o: (typeof TEST_OPTIONS)[number]) => {
    // Opened now, inside the click, so pop-up blockers allow it; it goes to the app once the session is set.
    const tab = window.open('', '_blank');
    setBusy(o.id);
    setError(null);
    setDone(null);
    try {
      const out = await call<{ user: { email: string } | null }>('POST', '/api/admin/test-session', { plan: o.plan, carConnected: o.car });
      localStorage.setItem('chargeone:welcomed', 'true');
      localStorage.removeItem('chargeone:plan');
      if (o.car) localStorage.setItem('chargeone:vehicle', JSON.stringify(myVehicleFromModel(NEXON)));
      if (tab) tab.location.href = '/';
      setDone({ label: o.label, email: out.user?.email ?? null, blocked: !tab });
    } catch (e) {
      tab?.close();
      onError(e);
      setError(e instanceof Error ? e.message : 'Could not start the test session.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-testid="admin-test">
      <Head title="Test as" />
      <p class="ad-muted">
        Signs this browser into the real app as a test account on that plan and opens it in a new tab. Test accounts start clean each time
        and are left out of every count. Your own Google sign-in in this browser is replaced.
      </p>
      <div class="ad-grid">
        {TEST_OPTIONS.map((o) => (
          <div key={o.id} class="ad-card">
            <strong>{o.label}</strong>
            <p class="ad-muted">{o.note}</p>
            <button type="button" class="ad-btn" disabled={busy !== null} onClick={() => start(o)} data-testid={`test-as-${o.id}`}>
              {busy === o.id ? 'Starting…' : `Open as ${o.label}`}
            </button>
          </div>
        ))}
      </div>
      {error && (
        <p class="ad-error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p class="ad-good" role="status" data-testid="test-as-done">
          Ready: {done.label}
          {done.email ? ` as ${done.email}` : ', signed out'}.{' '}
          {done.blocked ? (
            <a href="/" target="_blank" rel="noopener">
              The pop-up was blocked, open the app
            </a>
          ) : (
            'The app opened in a new tab.'
          )}
        </p>
      )}
    </section>
  );
}

// ---- Users ----

interface UserRow {
  id: string;
  /** Null for phone-only accounts. */
  email: string | null;
  name: string | null;
  username: string | null;
  /** Masked phone of a phone account. */
  phone: string | null;
  methods: Array<{ provider: 'google' | 'password' | 'phone'; display: string }>;
  createdAt: string;
  isTest: boolean;
  plan: string;
  planName: string;
  activeUntil: string | null;
  source: string | null;
}

const METHOD_LABEL: Record<UserRow['methods'][number]['provider'], string> = { google: 'Google', password: 'Email + password', phone: 'Phone' };

/** The email, else the masked phone, else the username. */
const accountLabel = (u: Pick<UserRow, 'email' | 'phone' | 'username'>) => u.email || u.phone || (u.username ? `@${u.username}` : 'No email');

function Users({ onError }: SectionProps) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, reload } = useLoad<{ users: UserRow[]; total: number; limit: number }>(
    `/api/admin/users?page=${page}&limit=25&q=${encodeURIComponent(query)}`,
    onError,
  );
  return (
    <section data-testid="admin-users">
      <Head title="Users" />
      <form
        class="ad-row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(q.trim());
        }}
      >
        <label class="ad-field ad-inline ad-grow">
          <span>Search by email, name or username</span>
          <input type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} maxLength={100} data-testid="users-search" />
        </label>
        <button type="submit" class="ad-btn">
          Search
        </button>
      </form>
      <Status error={error} loading={!data} />
      {data && (
        <>
          <p class="ad-muted">{data.total} accounts</p>
          <ul class="ad-list">
            {data.users.map((u) => (
              <li key={u.id} class="ad-item" data-testid="user-row">
                <button type="button" class="ad-rowbtn" aria-expanded={open === u.id} onClick={() => setOpen(open === u.id ? null : u.id)}>
                  <span>
                    <strong>{accountLabel(u)}</strong> <TestTag on={u.isTest} />
                    <span class="ad-muted"> {u.name ?? ''}</span>
                    {u.username ? <span class="ad-muted"> @{u.username}</span> : null}
                    <span class="ad-muted" data-testid="user-methods">
                      {' '}
                      · {u.methods?.length ? u.methods.map((m) => METHOD_LABEL[m.provider] + (m.provider === 'phone' && m.display ? ` ${m.display}` : '')).join(', ') : 'no sign-in'}
                    </span>
                  </span>
                  <span class="ad-muted">
                    {u.planName}
                    {u.activeUntil ? ` until ${when(u.activeUntil)}` : ''} · joined {when(u.createdAt)}
                  </span>
                </button>
                {open === u.id && (
                  <UserDetail
                    id={u.id}
                    onError={onError}
                    onChanged={reload}
                  />
                )}
              </li>
            ))}
          </ul>
          <Pager page={page} count={data.users.length} limit={data.limit} setPage={setPage} />
        </>
      )}
    </section>
  );
}

interface UserDetailData {
  user: UserRow;
  entitlement: { plan: string; activeUntil: string | null; status: string; source: string } | null;
  trial: { vehicle_model: string; started_at: string; ends_at: string } | null;
  counts: Record<string, number>;
  recentTrips: Array<{ id: string; counts: string; distance_km: number; created_at: string }>;
  upiPayments: Array<{ ref: string; plan: string; status: string; created_at: string }>;
}

function UserDetail({ id, onError, onChanged }: { id: string; onError: (e: unknown) => void; onChanged: () => void }) {
  const { data, error, reload } = useLoad<UserDetailData>(`/api/admin/users/${id}`, onError);
  const [plan, setPlan] = useState<string>('plus_monthly');
  const [days, setDays] = useState(30);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const act = async (path: string, body: unknown, done: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setMsg(null);
    try {
      await call('POST', `/api/admin/users/${id}/${path}`, body);
      setMsg({ ok: true, text: done });
      reload();
      onChanged();
    } catch (e) {
      onError(e);
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed.' });
    }
  };
  if (!data) return <Status error={error} loading />;
  const c = data.counts;
  return (
    <div class="ad-detail" data-testid="user-detail">
      <p>
        {data.entitlement
          ? `${PLANS[data.entitlement.plan as keyof typeof PLANS]?.name ?? data.entitlement.plan}, ${data.entitlement.status}, from ${data.entitlement.source}, until ${when(data.entitlement.activeUntil)}`
          : 'No plan on record.'}
        {data.trial ? ` Trial on ${data.trial.vehicle_model} until ${when(data.trial.ends_at)}.` : ''}
      </p>
      <p class="ad-muted">
        {c.trips} trips ({c.tripsToday} today) · {c.feedback} feedback · {c.reports} reports · {c.payments} payments
      </p>
      <div class="ad-row">
        <label class="ad-field ad-inline">
          <span>Plan</span>
          <select value={plan} onChange={(e) => setPlan(e.currentTarget.value)} data-testid="grant-plan">
            {PAID_PLANS.map((p) => (
              <option key={p} value={p}>
                {PLANS[p].name}
              </option>
            ))}
          </select>
        </label>
        <label class="ad-field ad-inline">
          <span>Days</span>
          <input type="number" min={1} max={400} value={days} onInput={(e) => setDays(Number(e.currentTarget.value))} />
        </label>
        <button type="button" class="ad-btn" onClick={() => act('grant', { plan, days }, `Granted ${PLANS[plan as keyof typeof PLANS].name} for ${days} days.`)} data-testid="grant-submit">
          Grant
        </button>
        <button type="button" class="ad-btn ad-danger" onClick={() => act('revoke', {}, 'Plan revoked.', `End ${accountLabel(data.user)}'s plan now? This does not refund or cancel a store subscription.`)}>
          Revoke
        </button>
        <button type="button" class="ad-btn ad-ghost" onClick={() => act('reset-quota', {}, 'Today’s trips and limits are cleared.')}>
          Reset today’s quota
        </button>
      </div>
      {msg && (
        <p class={msg.ok ? 'ad-good' : 'ad-error'} role="status">
          {msg.text}
        </p>
      )}
      {data.recentTrips.length > 0 && (
        <p class="ad-muted">
          Recent trips: {data.recentTrips.map((t) => `${Math.round(t.distance_km)} km (${t.counts}) ${when(t.created_at)}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

// ---- Lists ----

function usePaged<T>(path: string, key: string, onError: (e: unknown) => void) {
  const [page, setPage] = useState(1);
  const sep = path.includes('?') ? '&' : '?';
  const { data, error, reload } = useLoad<Record<string, T[]> & { limit: number }>(`${path}${sep}page=${page}&limit=25`, onError);
  return { rows: data ? data[key] : null, limit: data?.limit ?? 25, page, setPage, error, reload };
}

function Trips({ onError }: SectionProps) {
  const t = usePaged<{ id: string; counts: string; distance_km: number; replans: number; created_at: string; email: string; is_test: number }>(
    '/api/admin/trips',
    'trips',
    onError,
  );
  return (
    <section data-testid="admin-trips">
      <Head title="Trips">
        <button type="button" class="ad-btn ad-ghost" onClick={t.reload}>
          Refresh
        </button>
      </Head>
      <p class="ad-muted">Signed-in trips. Guest (Basic) trips are counted on the Overview, not stored.</p>
      <Status error={t.error} loading={!t.rows} />
      {t.rows && (
        <>
          <Table
            empty="No trips yet."
            head={['When', 'Driver', 'Distance', 'Counted as', 'Replans']}
            rows={t.rows.map((r) => [when(r.created_at), <>{r.email} <TestTag on={r.is_test} /></>, `${Math.round(r.distance_km)} km`, r.counts, r.replans])}
          />
          <Pager page={t.page} count={t.rows.length} limit={t.limit} setPage={t.setPage} />
        </>
      )}
    </section>
  );
}

function Feedback({ onError }: SectionProps) {
  const t = usePaged<{
    id: number;
    rating: number | null;
    category: string;
    message: string;
    screen: string | null;
    app_version: string | null;
    platform: string | null;
    email: string | null;
    is_test: number;
    signed_in: number;
    created_at: string;
  }>('/api/admin/feedback', 'feedback', onError);
  return (
    <section data-testid="admin-feedback">
      <Head title="Feedback">
        <button type="button" class="ad-btn ad-ghost" onClick={t.reload}>
          Refresh
        </button>
      </Head>
      <Status error={t.error} loading={!t.rows} />
      {t.rows && (
        <>
          {t.rows.length === 0 && <p class="ad-muted">No feedback yet.</p>}
          <ul class="ad-list">
            {t.rows.map((f) => (
              <li key={f.id} class="ad-item">
                <p>
                  <strong>{f.rating ? `${f.rating}/5` : 'No rating'}</strong> · {f.category} <TestTag on={f.is_test} />
                </p>
                <p class="ad-pre">{f.message}</p>
                <p class="ad-muted">
                  {when(f.created_at)} · {f.screen ?? 'unknown screen'} · {f.platform ?? ''} {f.app_version ?? ''} ·{' '}
                  {f.email ? <a href={`mailto:${f.email}`}>{f.email}</a> : f.signed_in ? 'signed in, no contact' : 'guest'}
                </p>
              </li>
            ))}
          </ul>
          <Pager page={t.page} count={t.rows.length} limit={t.limit} setPage={t.setPage} />
        </>
      )}
    </section>
  );
}

function Reports({ onError }: SectionProps) {
  const [problems, setProblems] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const t = usePaged<{
    id: number;
    station_id: string;
    station_name: string | null;
    kind: string;
    kw: number | null;
    vehicle: string | null;
    note: string | null;
    created_at: string;
    email: string;
    is_test: number;
  }>(`/api/admin/reports${problems ? '?problems=1' : ''}`, 'reports', onError);
  const remove = async (id: number, label: string) => {
    if (!confirm(`Delete this ${label} report? It disappears from the charger at once.`)) return;
    try {
      await call('DELETE', `/api/admin/reports/${id}`);
      setMsg('Report deleted.');
      t.reload();
    } catch (e) {
      onError(e);
      setMsg(e instanceof Error ? e.message : 'Could not delete.');
    }
  };
  return (
    <section data-testid="admin-reports">
      <Head title="Driver reports">
        <label class="ad-check">
          <input
            type="checkbox"
            checked={problems}
            onChange={(e) => {
              setProblems(e.currentTarget.checked);
              t.setPage(1);
            }}
          />
          <span>Problems only</span>
        </label>
      </Head>
      {msg && (
        <p class="ad-muted" role="status">
          {msg}
        </p>
      )}
      <Status error={t.error} loading={!t.rows} />
      {t.rows && (
        <>
          {t.rows.length === 0 && <p class="ad-muted">No reports.</p>}
          <ul class="ad-list">
            {t.rows.map((r) => (
              <li key={r.id} class="ad-item ad-split">
                <div>
                  <p>
                    <strong>{r.kind}</strong> at {r.station_name ?? r.station_id} {r.kw ? `· ${r.kw} kW` : ''} <TestTag on={r.is_test} />
                  </p>
                  {r.note && <p class="ad-pre">{r.note}</p>}
                  <p class="ad-muted">
                    {when(r.created_at)} · {r.email} {r.vehicle ? `· ${r.vehicle}` : ''}
                  </p>
                </div>
                <button type="button" class="ad-btn ad-danger" onClick={() => remove(r.id, r.kind)} aria-label={`Delete ${r.kind} report at ${r.station_name ?? r.station_id}`}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <Pager page={t.page} count={t.rows.length} limit={t.limit} setPage={t.setPage} />
        </>
      )}
    </section>
  );
}

function Payments({ onError }: SectionProps) {
  const [status, setStatus] = useState('claimed');
  const [msg, setMsg] = useState<string | null>(null);
  const { data, error, reload } = useLoad<{
    payments: Array<{ ref: string; plan: string; amount_paise: number; utr: string | null; status: string; created_at: string; claimed_at: string | null; email: string }>;
  }>(`/api/admin/upi?status=${status}`, onError);
  const decide = async (ref: string, decision: 'confirm' | 'reject') => {
    if (!confirm(decision === 'confirm' ? `Confirm ${ref}? Only if the money is in your bank account.` : `Reject ${ref}?`)) return;
    try {
      await call('POST', `/api/admin/upi/${encodeURIComponent(ref)}/${decision}`);
      setMsg(`${ref} ${decision === 'confirm' ? 'confirmed' : 'rejected'}.`);
      reload();
    } catch (e) {
      onError(e);
      setMsg(e instanceof Error ? e.message : 'Failed.');
    }
  };
  return (
    <section data-testid="admin-payments">
      <Head title="UPI payments">
        <label class="ad-field ad-inline">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
            <option value="claimed">Waiting for a decision</option>
            <option value="created">Started, not paid</option>
            <option value="confirmed">Confirmed</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
      </Head>
      <p class="ad-muted">Check the UTR against your bank statement before confirming. Card and store payments confirm themselves.</p>
      {msg && (
        <p class="ad-muted" role="status">
          {msg}
        </p>
      )}
      <Status error={error} loading={!data} />
      {data && (
        <>
          {data.payments.length === 0 && <p class="ad-muted">Nothing here.</p>}
          <ul class="ad-list">
            {data.payments.map((p) => (
              <li key={p.ref} class="ad-item ad-split">
                <div>
                  <p>
                    <strong>₹{(p.amount_paise / 100).toLocaleString('en-IN')}</strong> · {PLANS[p.plan as keyof typeof PLANS]?.name ?? p.plan} · <code>{p.ref}</code>
                  </p>
                  <p class="ad-muted">
                    {p.email} · UTR {p.utr ?? '–'} · {when(p.claimed_at ?? p.created_at)}
                  </p>
                </div>
                {p.status === 'claimed' && (
                  <div class="ad-row">
                    <button type="button" class="ad-btn" onClick={() => decide(p.ref, 'confirm')}>
                      Confirm
                    </button>
                    <button type="button" class="ad-btn ad-danger" onClick={() => decide(p.ref, 'reject')}>
                      Reject
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Audit({ onError }: SectionProps) {
  const t = usePaged<{ id: number; action: string; target: string | null; detail: string | null; ip_hash: string; at: string }>('/api/admin/audit', 'audit', onError);
  return (
    <section data-testid="admin-audit">
      <Head title="Audit log">
        <button type="button" class="ad-btn ad-ghost" onClick={t.reload}>
          Refresh
        </button>
      </Head>
      <p class="ad-muted">Every sign-in and change made from this console. Network addresses are stored hashed.</p>
      <Status error={t.error} loading={!t.rows} />
      {t.rows && (
        <>
          <Table
            empty="Nothing logged yet."
            head={['When', 'Action', 'Target', 'Detail', 'From']}
            rows={t.rows.map((r) => [when(r.at), r.action, r.target ?? '–', <code class="ad-pre">{r.detail ?? ''}</code>, <code>{r.ip_hash.slice(0, 10)}</code>])}
          />
          <Pager page={t.page} count={t.rows.length} limit={t.limit} setPage={t.setPage} />
        </>
      )}
    </section>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: ComponentChildren[][]; empty: string }) {
  if (rows.length === 0) return <p class="ad-muted">{empty}</p>;
  return (
    <div class="ad-scroll" tabIndex={0} role="region" aria-label="Results">
      <table class="ad-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} data-label={head[j]}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
