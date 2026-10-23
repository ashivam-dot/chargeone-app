import { useEffect, useMemo, useState } from 'preact/hooks';
import type { DetailField, Station } from '../data/model.ts';
import { TRUST_LABEL, fieldSource, reportAge, speedUnknown, trustBadge, trustReason } from '../data/trust.ts';
import { safeUrl } from '../data/normalize.ts';
import type { Place, PlacesData } from '../data/places.ts';
import { nearbyPlaces, sortStays } from '../planner/journey.ts';
import { NearbyPlaces } from './NearbyPlaces.tsx';
import { ApiError, api, currentPosition, type Report } from '../lib/api.ts';
import { SPEED_LABEL, VEHICLE_LABEL, directionsUrl, formatDate, formatKw, latestUpdate, stationLink } from '../lib/format.ts';
import { REPORT_LABEL, chargerState, liveState, stateReason, timeAgo, type ReportKind, type StationStatus } from '../shared/status.ts';
import { StateBadge } from './StateIcon.tsx';
import { IS_NATIVE } from '../native/bridge.ts';
import { isOperatorAppInstalled, openOperatorApp } from '../native/operatorApp.ts';
import { deviceFromUa, operatorAppFor, webLink, type OperatorApp } from '../shared/operatorApps.ts';
import { Sheet } from './Sheet.tsx';

interface Props {
  station: Station;
  status: StationStatus | undefined;
  signedIn: boolean;
  vehicleName: string | null;
  onClose: () => void;
  onRequireSignIn: () => void;
  onReported: () => void;
  onPlanTo: (s: Station) => void;
  places: PlacesData | null;
  placesLoading: boolean;
  placesFailed: boolean;
  onOpenPlace: (p: Place) => void;
  /** True when the charger's details (hours, price, address, sources) couldn't be read. */
  detailFailed?: boolean;
  /** Read the charger's details again after they failed. */
  onRetryDetail?: () => void;
}

const GOOD: ReportKind[] = ['worked', 'charging_now'];
const BAD: ReportKind[] = ['broken', 'slow', 'blocked', 'queue'];

/** The charging network's own app: open it if installed, else its store page, else its website. */
function OperatorAppLink({ app }: { app: OperatorApp }) {
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    let live = true;
    if (IS_NATIVE) void isOperatorAppInstalled(app).then((v) => live && setInstalled(v));
    return () => {
      live = false;
    };
  }, [app]);
  if (IS_NATIVE) {
    return (
      <button class="btn btn--glass operator-app" onClick={() => void openOperatorApp(app)} data-testid="operator-app">
        {installed ? `Open in ${app.name}` : `Get the ${app.name} app`}
      </button>
    );
  }
  const device = deviceFromUa(navigator.userAgent, navigator.maxTouchPoints);
  const link = webLink(app, device);
  if (!link) return null;
  return (
    <a class="btn btn--glass operator-app" href={link.href} target="_blank" rel="noopener noreferrer" data-testid="operator-app">
      {link.kind === 'store' ? `Open the ${app.name} app` : `${app.name} website`}
    </a>
  );
}

function LiveBlock({ station, status, app }: { station: Station; status: StationStatus | undefined; app: OperatorApp | null }) {
  const now = new Date();
  const state = liveState(status, now);
  // The same state, glyph and words as the map pin.
  const pin = chargerState(station, status, now);
  const lines: string[] = [];
  if (status?.lastWorkedAt) {
    const kw = status.lastWorkedKw ? ` at ${formatKw(status.lastWorkedKw)}` : '';
    const car = status.lastWorkedVehicle ? ` · ${status.lastWorkedVehicle}` : '';
    lines.push(`Last charged fine ${timeAgo(status.lastWorkedAt, now)}${kw}${car}`);
  }
  if (status?.inUseSince && state === 'in_use') lines.push(`Someone started charging ${timeAgo(status.inUseSince, now)}`);
  if (status?.queueAt && state === 'in_use') lines.push(`Queue reported ${timeAgo(status.queueAt, now)}`);
  if (status?.problemAt) {
    const n = status.problemReports > 1 ? ` (${status.problemReports} reports)` : '';
    lines.push(`${REPORT_LABEL[status.problemKind ?? 'broken']} reported ${timeAgo(status.problemAt, now)}${n}`);
  }
  return (
    <div class={`live live--${pin.state}`} role="status" data-testid="live-status" data-state={pin.state}>
      <div class="live__head">
        <StateBadge state={pin.state} />
        {status && <span class="live__count">{status.reports7d} report{status.reports7d === 1 ? '' : 's'} this week</span>}
      </div>
      <p class="live__why small">{stateReason(pin, station)}</p>
      {lines.length > 0 ? (
        <ul class="live__lines">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p class="muted">No driver has reported this charger in the last 7 days. Be the first after you charge.</p>
      )}
      <p class="live__source small muted">
        From ChargeOne drivers' reports, not live from the operator.{app ? ` For live status and payment, use the ${app.name} app.` : ''}
      </p>
      {app && <OperatorAppLink app={app} />}
    </div>
  );
}

export function StationSheet(props: Props) {
  const { station, status, signedIn, vehicleName, onClose, onRequireSignIn, onReported, onPlanTo, places } = props;
  const food = useMemo(() => nearbyPlaces(places, station.id, 'f'), [places, station.id]);
  const stays = useMemo(() => sortStays(nearbyPlaces(places, station.id, 's')), [places, station.id]);
  const area = places?.area[station.id] ?? null;
  const operatorApp = useMemo(() => operatorAppFor(station), [station.id]);
  // 'error' when the reports couldn't be read: that is not the same as "no reports yet".
  const [reports, setReports] = useState<Report[] | 'error' | null>(null);
  const [reportsTry, setReportsTry] = useState(0);
  const [sending, setSending] = useState<ReportKind | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [kw, setKw] = useState('');
  const [copied, setCopied] = useState(false);
  // Reports are kept under the stable c1 id; the worker also accepts the older osm-/ocm- ids.
  const reportId = station.c1Id ?? station.id;

  useEffect(() => {
    setReports(null);
    setMessage(null);
    setKw('');
    let live = true;
    api
      .reports(reportId)
      .then((r) => live && setReports(r.reports))
      .catch(() => live && setReports('error'));
    return () => {
      live = false;
    };
  }, [reportId, reportsTry]);

  const report = async (kind: ReportKind) => {
    if (!signedIn) {
      onRequireSignIn();
      return;
    }
    setSending(kind);
    setMessage(null);
    try {
      const pos = await currentPosition();
      const parsedKw = Number(kw);
      await api.checkin({
        stationId: reportId,
        kind,
        kw: GOOD.includes(kind) && parsedKw >= 0.5 && parsedKw <= 400 ? parsedKw : undefined,
        vehicle: vehicleName ?? undefined,
        position: { lat: pos.coords.latitude, lng: pos.coords.longitude },
        accuracy: Math.round(pos.coords.accuracy),
      });
      setMessage({ kind: 'ok', text: 'Thanks! Other drivers can see this now.' });
      onReported();
      api.reports(reportId).then((r) => setReports(r.reports)).catch(() => undefined);
    } catch (e) {
      let text = e instanceof Error ? e.message : 'Could not send the report.';
      if (e instanceof ApiError && e.code === 'too_far' && typeof e.extra.distanceM === 'number') {
        text = `You seem to be ${(e.extra.distanceM / 1000).toFixed(1)} km away. Reports only count from the charger itself.`;
      }
      if (e instanceof ApiError && e.status === 401) onRequireSignIn();
      setMessage({ kind: 'error', text });
    } finally {
      setSending(null);
    }
  };

  const share = async () => {
    const url = stationLink(station.id);
    try {
      if (navigator.share) await navigator.share({ title: station.name, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // User cancelled the share sheet.
    }
  };

  const updated = formatDate(latestUpdate(station));
  const website = safeUrl(station.website);
  const now = new Date();
  const pending = station.detail === 'pending';
  const later = pending ? (props.detailFailed ? "Couldn't load" : 'Loading…') : null;
  const badge = trustBadge(station, status, now);
  const reported = reportAge(status, now);
  // Unknown stays unknown: nothing missing is shown as "no", "closed" or 0.
  const facts: Array<{ key: string; label: string; value: string; field?: DetailField; unknown: boolean }> = [];
  const fact = (label: string, value: string | null, field?: DetailField, missing = 'Not listed') =>
    facts.push({ key: label, label, value: value ?? missing, field: value === null ? undefined : field, unknown: value === null });
  fact('Operator', station.operator, 'operator');
  fact(
    'Speed',
    speedUnknown(station) ? null : `${SPEED_LABEL[station.speed]}${station.maxKw ? ` · up to ${formatKw(station.maxKw)}` : ''}`,
    'maxKw',
    'Unknown',
  );
  fact('Charging points', station.points === null ? null : String(station.points), 'points');
  fact('Hours', station.is24x7 ? 'Open 24×7' : station.hours ?? later, 'hours');
  fact('Price', station.price ?? later, 'price');
  fact('For', station.vehicles.length ? station.vehicles.map((v) => VEHICLE_LABEL[v]).join(', ') : null, undefined, 'Unknown');
  fact('Access', station.access === 'customers' ? 'Customers only' : station.access === 'public' ? 'Public' : null, 'access', 'Unknown');
  if (station.state) fact('State', station.state);

  return (
    <Sheet title={station.name} onClose={onClose}>
      <p class="station__sub">
        {[station.operator ?? 'Operator not listed', station.address ?? area].filter(Boolean).join(' · ')}
      </p>

      <div class="trust" data-testid="trust">
        {/* Plain text, not a second pill: the state badge in the live block is the sheet's one status badge. */}
        <span class={`trust__label trust__label--${badge}`} data-testid="trust-badge">
          Listing: {TRUST_LABEL[badge]}
        </span>
        {speedUnknown(station) && (
          <span class="trust__badge trust__badge--speed" data-testid="speed-unknown">
            Speed unknown
          </span>
        )}
        <span class="trust__why small muted">
          {trustReason(station, status, now)}
          {reported ? ` ${reported}.` : ''}
        </span>
      </div>

      <div class="actions">
        <a class="btn btn--primary" href={directionsUrl(station)} target="_blank" rel="noopener noreferrer">
          Directions
        </a>
        <button class="btn" onClick={() => onPlanTo(station)}>
          Plan trip here
        </button>
        <button class="btn" onClick={share}>
          {copied ? 'Link copied' : 'Share'}
        </button>
      </div>

      <LiveBlock station={station} status={status} app={operatorApp} />

      <section class="report" aria-label="Report this charger">
        <h3>Are you here now?</h3>
        <p class="muted small">Your report helps the next driver. You need to be at the charger.</p>
        <div class="report__kw">
          <label for="kw-input">Speed you got (optional)</label>
          <input id="kw-input" type="number" inputMode="decimal" min={0.5} max={400} step={0.5} placeholder="kW" value={kw} onInput={(e) => setKw((e.target as HTMLInputElement).value)} />
        </div>
        <div class="report__grid">
          {GOOD.map((k) => (
            <button key={k} class="btn btn--good" disabled={sending !== null} onClick={() => report(k)}>
              {sending === k ? 'Sending…' : REPORT_LABEL[k]}
            </button>
          ))}
          {BAD.map((k) => (
            <button key={k} class="btn btn--bad" disabled={sending !== null} onClick={() => report(k)}>
              {sending === k ? 'Sending…' : REPORT_LABEL[k]}
            </button>
          ))}
        </div>
        {message && (
          <p class={`notice notice--${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
            {message.text}
          </p>
        )}
      </section>

      <NearbyPlaces key={`${station.id}:${places ? 1 : 0}`} food={food} stays={stays} area={area} loading={props.placesLoading} failed={props.placesFailed} onOpen={props.onOpenPlace} />

      {station.connectors.length > 0 ? (
        <section aria-label="Connectors">
          <h3>Connectors</h3>
          {fieldSource(station, 'connectors') && <p class="fact__src small muted">{fieldSource(station, 'connectors')}</p>}
          <ul class="connectors">
            {station.connectors.map((c, i) => (
              <li key={`${c.type}-${i}`}>
                <strong>{c.type}</strong>
                <span>{[c.count ? `×${c.count}` : null, formatKw(c.kw)].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p class="notice" data-testid="connectors-unknown">
          Connectors: not listed. No source says which plugs this charger has, so check before you drive here.
        </p>
      )}

      <dl class="facts" data-testid="facts">
        {facts.map((f) => {
          const src = f.field ? fieldSource(station, f.field) : null;
          return (
            <div key={f.key} data-fact={f.key}>
              <dt>{f.label}</dt>
              <dd class={f.unknown ? 'fact--unknown' : undefined}>
                {f.value}
                {src && <small class="fact__src">{src}</small>}
              </dd>
            </div>
          );
        })}
        {station.address && fieldSource(station, 'address') && (
          <div data-fact="Address">
            <dt>Address</dt>
            <dd>
              {station.address}
              <small class="fact__src">{fieldSource(station, 'address')}</small>
            </dd>
          </div>
        )}
      </dl>
      {pending && props.detailFailed && props.onRetryDetail && (
        <p class="small muted" data-testid="detail-failed">
          Couldn't load this charger's hours and price. Check your connection.{' '}
          <button class="link link--inline" onClick={props.onRetryDetail} data-testid="retry-detail">
            Try again
          </button>
        </p>
      )}

      <section aria-label="Recent reports">
        <h3>Recent reports</h3>
        {reports === null ? (
          <p class="muted">Loading…</p>
        ) : reports === 'error' ? (
          <p class="muted" data-testid="reports-error">
            Couldn't load reports. Check your connection.{' '}
            <button class="link link--inline" onClick={() => setReportsTry((n) => n + 1)} data-testid="retry-reports">
              Try again
            </button>
          </p>
        ) : reports.length === 0 ? (
          <p class="muted">No reports yet.</p>
        ) : (
          <ul class="reports">
            {reports.map((r) => (
              <li key={r.created_at + r.kind}>
                <span class={`tag tag--${GOOD.includes(r.kind) ? 'good' : 'bad'}`}>{REPORT_LABEL[r.kind]}</span>
                <span>{[r.kw ? formatKw(r.kw) : null, r.vehicle].filter(Boolean).join(' · ')}</span>
                <time dateTime={r.created_at}>{timeAgo(r.created_at, new Date())}</time>
                {r.note && <p class="reports__note">{r.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer class="station__foot small muted">
        {website && (
          <a href={website} target="_blank" rel="noopener noreferrer nofollow">
            Operator website
          </a>
        )}
        {station.sources.map((s) => (
          <a key={s.id} href={s.editUrl ?? s.url} target="_blank" rel="noopener noreferrer">
            {s.editUrl ? `Fix on ${s.name}` : `View on ${s.name}`}
          </a>
        ))}
        {updated && <span>Map data updated {updated}</span>}
      </footer>
    </Sheet>
  );
}
