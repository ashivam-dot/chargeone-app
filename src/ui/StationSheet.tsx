import { useEffect, useState } from 'preact/hooks';
import type { Station } from '../data/model.ts';
import { safeUrl } from '../data/normalize.ts';
import { ApiError, api, currentPosition, type Report } from '../lib/api.ts';
import { SPEED_LABEL, VEHICLE_LABEL, directionsUrl, formatDate, formatKw, latestUpdate, stationLink } from '../lib/format.ts';
import { LIVE_COLOUR, LIVE_LABEL, REPORT_LABEL, liveState, timeAgo, type ReportKind, type StationStatus } from '../shared/status.ts';
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
}

const GOOD: ReportKind[] = ['worked', 'charging_now'];
const BAD: ReportKind[] = ['broken', 'slow', 'blocked', 'queue'];

function LiveBlock({ status }: { status: StationStatus | undefined }) {
  const now = new Date();
  const state = liveState(status, now);
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
    <div class={`live live--${state}`} role="status">
      <div class="live__head">
        <span class="live__dot" style={{ background: LIVE_COLOUR[state] }} aria-hidden="true" />
        <strong>{LIVE_LABEL[state]}</strong>
        {status && <span class="live__count">{status.reports7d} report{status.reports7d === 1 ? '' : 's'} this week</span>}
      </div>
      {lines.length > 0 ? (
        <ul class="live__lines">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p class="muted">No driver has reported this charger in the last 7 days. Be the first after you charge.</p>
      )}
    </div>
  );
}

export function StationSheet({ station, status, signedIn, vehicleName, onClose, onRequireSignIn, onReported, onPlanTo }: Props) {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [sending, setSending] = useState<ReportKind | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [kw, setKw] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setReports(null);
    setMessage(null);
    setKw('');
    let live = true;
    api
      .reports(station.id)
      .then((r) => live && setReports(r.reports))
      .catch(() => live && setReports([]));
    return () => {
      live = false;
    };
  }, [station.id]);

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
        stationId: station.id,
        kind,
        kw: GOOD.includes(kind) && parsedKw >= 0.5 && parsedKw <= 400 ? parsedKw : undefined,
        vehicle: vehicleName ?? undefined,
        position: { lat: pos.coords.latitude, lng: pos.coords.longitude },
        accuracy: Math.round(pos.coords.accuracy),
      });
      setMessage({ kind: 'ok', text: 'Thanks! Other drivers can see this now.' });
      onReported();
      api.reports(station.id).then((r) => setReports(r.reports)).catch(() => undefined);
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
  const facts: Array<[string, string]> = [];
  facts.push(['Speed', `${SPEED_LABEL[station.speed]}${station.maxKw ? ` · up to ${formatKw(station.maxKw)}` : ''}`]);
  if (station.points) facts.push(['Charging points', String(station.points)]);
  if (station.hours || station.is24x7) facts.push(['Hours', station.is24x7 ? 'Open 24×7' : (station.hours ?? '')]);
  if (station.price) facts.push(['Price', station.price]);
  if (station.vehicles.length) facts.push(['For', station.vehicles.map((v) => VEHICLE_LABEL[v]).join(', ')]);
  if (station.access === 'customers') facts.push(['Access', 'Customers only']);

  return (
    <Sheet title={station.name} onClose={onClose}>
      <p class="station__sub">
        {[station.operator, station.address].filter(Boolean).join(' · ') || 'Operator not mapped yet'}
      </p>

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

      <LiveBlock status={status} />

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

      {station.connectors.length > 0 ? (
        <section aria-label="Connectors">
          <h3>Connectors</h3>
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
        <p class="notice">Connector types aren't mapped for this charger yet. Check before you drive here.</p>
      )}

      <dl class="facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      <section aria-label="Recent reports">
        <h3>Recent reports</h3>
        {reports === null ? (
          <p class="muted">Loading…</p>
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
