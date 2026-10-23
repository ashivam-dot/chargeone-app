// Open Charge Map (CC BY 4.0), compact form: ids only, joined with referencedata.json. The GitHub export
// and the API with compact=true give the same shape, so both adapters share this mapper.
import type { ConnectorType } from '../../src/data/model.ts';
import { ocmConnectorType, safeUrl } from '../../src/data/normalize.ts';
import { roundKw } from '../lib/connectors.ts';
import { inIndia, round6 } from '../lib/geo.ts';
import { canonicalOperator, differentOperators, knownOperator } from '../lib/operators.ts';
import { STOPWORDS, tokenize } from '../lib/text.ts';
import { canonicalState } from '../lib/states.ts';
import { inferSwap, inferVehicles, NO_VEHICLE_FLAGS } from '../lib/vehicle.ts';
import type { Access, AdapterResult, CanonicalEvse, HealthReport, PowerType, Rejection, SourceRecord, SourceStatus, Tri } from '../types.ts';

export interface OcmConnection {
  ID?: number;
  ConnectionTypeID?: number | null;
  StatusTypeID?: number | null;
  LevelID?: number | null;
  Amps?: number | null;
  Voltage?: number | null;
  PowerKW?: number | null;
  CurrentTypeID?: number | null;
  Quantity?: number | null;
}

export interface OcmCompactPoi {
  ID: number;
  UUID?: string;
  DataProviderID?: number | null;
  OperatorID?: number | null;
  OperatorsReference?: string | null;
  UsageTypeID?: number | null;
  UsageCost?: string | null;
  AddressInfo?: {
    Title?: string | null;
    AddressLine1?: string | null;
    AddressLine2?: string | null;
    Town?: string | null;
    StateOrProvince?: string | null;
    Postcode?: string | null;
    CountryID?: number | null;
    Latitude?: number | null;
    Longitude?: number | null;
    AccessComments?: string | null;
    RelatedURL?: string | null;
  } | null;
  Connections?: OcmConnection[] | null;
  NumberOfPoints?: number | null;
  GeneralComments?: string | null;
  StatusTypeID?: number | null;
  DateLastVerified?: string | null;
  DateLastStatusUpdate?: string | null;
  DateCreated?: string | null;
  SubmissionStatusTypeID?: number | null;
}

interface Titled {
  ID: number;
  Title: string | null;
}

export interface OcmReferenceData {
  ConnectionTypes: Array<Titled & { FormalName?: string | null }>;
  CurrentTypes: Titled[];
  Operators: Array<Titled & { WebsiteURL?: string | null }>;
  StatusTypes: Array<Titled & { IsOperational?: boolean | null }>;
  UsageTypes: Array<Titled & { IsMembershipRequired?: boolean | null }>;
  SubmissionStatusTypes: Array<Titled & { IsLive?: boolean | null }>;
  DataProviders: Array<Titled & { License?: string | null }>;
  Countries: Array<Titled & { ISOCode: string }>;
}

export interface OcmRaw {
  pois: OcmCompactPoi[];
  ref: OcmReferenceData;
  snapshotAt: string | null;
  origin: 'export' | 'api';
}

const INDIA_COUNTRY_ID = 106;
/** Data provider 1 is "Open Charge Map Contributors", CC BY 4.0. Other providers carry other licences. */
const OCM_CONTRIBUTORS = 1;

/** 100 Not Operational, 150 Planned, 200 Removed (Decommissioned), 210 Removed (Duplicate Listing). */
const DROP_STATUS: Record<number, Rejection['reason']> = { 100: 'not-operational', 150: 'planned', 200: 'removed', 210: 'removed' };
/** 30 Temporarily Unavailable, 75 Partly Operational: shown, but flagged. */
const FLAG_STATUS: Record<number, SourceStatus> = { 30: 'temporarily_unavailable', 75: 'partly_operational' };

/**
 * Records copied from Google Maps (Google Place IDs, Maps links). Google's terms forbid storing them: never
 * ship. Covers maps.google.*, google.<tld>/maps, goo.gl/maps, the maps.app.goo.gl share links and g.page.
 */
export const GOOGLE_DERIVED = /google\s*place|\bChIJ[0-9A-Za-z_-]{10,}|maps\.google\.|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl|g\.page\//i;

/** Every free-text value in a POI (titles, addresses, comments, URLs, media captions), for the Google scan. */
function freeText(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) freeText(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) freeText(v, out);
  return out;
}

const CURRENT: Record<number, PowerType> = { 10: 'AC_1_PHASE', 20: 'AC_3_PHASE', 30: 'DC' };

/** OCM connection type ids that its titles don't map cleanly. */
const CONNECTION_OVERRIDES: Record<number, ConnectorType> = {
  // Type M (IS 1293), the Indian 15 A domestic socket.
  1043: '3-pin socket',
  // IEC 60309 / CEE 3-pin (blue commando) at 3.3 kW single phase is the Bharat AC-001 outlet in India.
  16: 'Bharat AC',
  34: 'Bharat AC',
  4: 'Bharat AC',
};

function lookup<T extends Titled>(list: T[]): Map<number, T> {
  return new Map(list.map((x) => [x.ID, x]));
}

export interface OcmLookups {
  connection: Map<number, OcmReferenceData['ConnectionTypes'][number]>;
  operator: Map<number, OcmReferenceData['Operators'][number]>;
  usage: Map<number, OcmReferenceData['UsageTypes'][number]>;
  submission: Map<number, OcmReferenceData['SubmissionStatusTypes'][number]>;
  /** OCM's charging networks as [canonical name, its name tokens], for spotting a network named in a title. */
  networks: Array<[string, string[]]>;
}

export function ocmLookups(ref: OcmReferenceData): OcmLookups {
  const networks = new Map<string, string[]>();
  for (const o of ref.Operators) {
    const name = canonicalOperator(o.Title);
    if (!name || /no longer active/i.test(o.Title ?? '')) continue;
    const tokens = tokenize(name);
    // "CHARGE+" is just "charge": a network whose name is only generic words can't be spotted in a title.
    if (tokens.some((t) => !STOPWORDS.has(t))) networks.set(name, tokens);
  }
  return {
    connection: lookup(ref.ConnectionTypes),
    operator: lookup(ref.Operators),
    usage: lookup(ref.UsageTypes),
    submission: lookup(ref.SubmissionStatusTypes),
    networks: [...networks],
  };
}

const compact = (tokens: string[]) => tokens.join('');

/**
 * A charging network the title names that isn't the mapped operator, or null. Titles often name the host
 * ("Popular Hyundai", "KSEB EVCS - ChargeMOD"), so only OCM's own networks count, and only when the title
 * doesn't also name the mapped operator. "Earthtron EV" under CHARGE+ gives EarthtronEV.
 */
export function titleNetwork(title: string | null, mapped: string, l: Pick<OcmLookups, 'networks'>): string | null {
  if (!title) return null;
  const words = tokenize(title);
  const joined = compact(words);
  const names = (tokens: string[]) => {
    const c = compact(tokens);
    // Whole words in order ("earthtron ev"), or run together ("EarthtronEV" in "Earthtron EV").
    return c.length >= 4 && (words.join(' ').match(new RegExp(`(^| )${tokens.join(' ')}( |$)`)) !== null || (c.length >= 6 && joined.includes(c)));
  };
  if (names(tokenize(mapped)) || knownOperator(title) === mapped) return null;
  const hit = l.networks.filter(([n, tokens]) => differentOperators(n, mapped) && names(tokens)).sort(([, a], [, b]) => compact(b).length - compact(a).length)[0];
  return hit?.[0] ?? null;
}

function connectorStandard(c: OcmConnection, l: OcmLookups): ConnectorType {
  const id = c.ConnectionTypeID ?? 0;
  const powerType = c.CurrentTypeID ? CURRENT[c.CurrentTypeID] : undefined;
  const override = CONNECTION_OVERRIDES[id];
  if (override === 'Bharat AC') {
    const kw = roundKw(c.PowerKW);
    // Only the single-phase 3.3 kW outlet is AC-001; anything else stays generic.
    return powerType !== 'DC' && powerType !== 'AC_3_PHASE' && (kw === null || kw <= 3.6) ? 'Bharat AC' : 'Other';
  }
  if (override) return override;
  const t = l.connection.get(id);
  if (!t || id === 0) return 'Other';
  return ocmConnectorType(`${t.Title ?? ''} ${t.FormalName ?? ''}`, powerType === 'DC' ? 'DC' : powerType ? 'AC' : '');
}

function usageAccess(usageId: number | null | undefined): { access: Access; membership: Tri; reject: boolean } {
  switch (usageId) {
    case 1:
    case 5:
    case 7:
      return { access: 'public', membership: usageId === 1 ? null : false, reject: false };
    case 4:
      // "Public - Membership Required": an operator app account, as for most Indian networks.
      return { access: 'public', membership: true, reject: false };
    case 6:
    case 3:
      return { access: 'customers', membership: null, reject: false };
    case 2:
      return { access: 'unknown', membership: true, reject: true };
    default:
      return { access: 'unknown', membership: null, reject: false };
  }
}

/** DateLastVerified, unless it equals DateCreated: that's a bulk import, not a check. */
export function ocmObservedAt(poi: OcmCompactPoi): { observedAt: string | null; verified: boolean } {
  const verified = poi.DateLastVerified ?? null;
  if (verified && verified !== poi.DateCreated) return { observedAt: verified, verified: true };
  return { observedAt: poi.DateCreated ?? verified, verified: false };
}

export function ocmRecord(poi: OcmCompactPoi, l: OcmLookups): SourceRecord | Rejection {
  const sourceId = `ocm-${poi.ID}`;
  const reject = (reason: Rejection['reason'], quarantine = false): Rejection => ({ sourceId, reason, quarantine });

  if (GOOGLE_DERIVED.test(freeText(poi).join(' '))) return reject('google-derived', true);
  if ((poi.DataProviderID ?? OCM_CONTRIBUTORS) !== OCM_CONTRIBUTORS) return reject('other-licence', true);
  if (poi.SubmissionStatusTypeID != null && l.submission.get(poi.SubmissionStatusTypeID)?.IsLive === false) return reject('not-live');
  const dropped = poi.StatusTypeID != null ? DROP_STATUS[poi.StatusTypeID] : undefined;
  if (dropped) return reject(dropped);

  const a = poi.AddressInfo;
  if (!a || typeof a.Latitude !== 'number' || typeof a.Longitude !== 'number') return reject('no-coordinates');
  if ((a.CountryID != null && a.CountryID !== INDIA_COUNTRY_ID) || !inIndia(a.Latitude, a.Longitude)) return reject('outside-india');
  const usage = usageAccess(poi.UsageTypeID);
  if (usage.reject) return reject('private');

  const flags: string[] = [];
  const evses: CanonicalEvse[] = [];
  const listed = poi.Connections ?? [];
  const dropReasons: Array<Rejection['reason']> = [];
  /** Status of each connection kept: 30 temporarily unavailable, 75 partly operational, else working or unknown. */
  const kept: Array<number | null> = [];
  let tethered = false;
  for (const [i, c] of listed.entries()) {
    if (c.StatusTypeID != null && DROP_STATUS[c.StatusTypeID]) {
      dropReasons.push(DROP_STATUS[c.StatusTypeID]);
      continue;
    }
    kept.push(c.StatusTypeID ?? null);
    if (/tethered/i.test(l.connection.get(c.ConnectionTypeID ?? 0)?.Title ?? '')) tethered = true;
    const standard = connectorStandard(c, l);
    const quantity = c.Quantity && c.Quantity > 0 && c.Quantity < 100 ? c.Quantity : null;
    evses.push({
      uid: `${sourceId}:${c.ID ?? i}`,
      connectors: [
        {
          standard,
          powerType: (c.CurrentTypeID ? CURRENT[c.CurrentTypeID] : null) ?? (standard === '3-pin socket' || standard === 'Bharat AC' ? 'AC_1_PHASE' : null),
          // 0 kW means "not entered", not zero.
          maxKw: roundKw(c.PowerKW),
          count: quantity,
        },
      ],
    });
  }

  // Every connection listed is non-operational, planned or removed: so is the charger, whatever the POI says.
  if (listed.length > 0 && evses.length === 0) {
    return reject(dropReasons.every((r) => r === dropReasons[0]) ? dropReasons[0] : 'removed');
  }
  if (dropReasons.length) flags.push('connection-removed');

  const opRef = poi.OperatorID != null ? l.operator.get(poi.OperatorID) : undefined;
  const mapped = canonicalOperator(opRef?.Title) ?? canonicalOperator(poi.OperatorsReference);
  const name = a.Title?.trim() || null;
  const inferred = mapped ? null : knownOperator(name);
  const operator = mapped ?? inferred;
  const titled = mapped ? titleNetwork(name, mapped, l) : null;
  if (titled) flags.push('operator-conflict');
  const { observedAt, verified } = ocmObservedAt(poi);
  if (!verified) flags.push('bulk-unverified');
  let status: SourceStatus = poi.StatusTypeID != null ? (FLAG_STATUS[poi.StatusTypeID] ?? (poi.StatusTypeID === 50 ? 'operational' : 'unknown')) : 'unknown';
  if (poi.StatusTypeID === 30 || poi.StatusTypeID === 75) flags.push(`ocm-status-${poi.StatusTypeID}`);
  // The connections can say more than the POI: all down is temporarily unavailable, some down is partly working.
  const down = kept.filter((k) => k === 30).length;
  const partly = kept.filter((k) => k === 75).length;
  if (kept.length > 0 && down === kept.length) {
    status = 'temporarily_unavailable';
    flags.push('ocm-connections-30');
  } else if (down + partly > 0 || dropReasons.length > 0) {
    if (status === 'operational') status = 'partly_operational';
    flags.push(down + partly > 0 ? 'ocm-connections-partly' : 'connection-removed');
  }
  // "Operational" with no equipment listed says nothing about what works there.
  if (evses.length === 0 && status === 'operational') status = 'unknown';
  const connectors = evses.flatMap((e) => e.connectors);
  const address = [a.AddressLine1, a.AddressLine2, a.Town, a.StateOrProvince, a.Postcode]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join(', ');
  const price = poi.UsageCost?.trim() || null;

  return {
    source: 'ocm',
    sourceId,
    url: `https://openchargemap.org/site/poi/details/${poi.ID}`,
    editUrl: `https://openchargemap.org/site/poi/edit/${poi.ID}`,
    licence: 'CC-BY-4.0',
    observedAt,
    verified,
    lat: round6(a.Latitude),
    lng: round6(a.Longitude),
    name,
    operator,
    operatorMethod: mapped ? 'mapped' : inferred ? 'inferred' : null,
    evses,
    points: poi.NumberOfPoints && poi.NumberOfPoints > 0 && poi.NumberOfPoints < 100 ? poi.NumberOfPoints : null,
    stationKw: null,
    hours: null,
    price: price === '0' ? 'Free' : price,
    access: usage.access,
    membershipRequired: usage.membership,
    address: address || null,
    stateHint: canonicalState(a.StateOrProvince),
    website: safeUrl(opRef?.WebsiteURL ?? undefined),
    vehicles: inferVehicles({ explicit: NO_VEHICLE_FLAGS, connectors, operator, name, stationKw: null, tethered }),
    batterySwap: inferSwap(operator, name),
    status,
    flags: [...new Set(flags)],
    ...(titled ? { titleOperator: titled } : {}),
  };
}

export function ocmToCanonical(raw: OcmRaw): AdapterResult {
  const l = ocmLookups(raw.ref);
  const records: SourceRecord[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<number>();
  for (const poi of [...raw.pois].sort((x, y) => x.ID - y.ID)) {
    if (seen.has(poi.ID)) continue;
    seen.add(poi.ID);
    const r = ocmRecord(poi, l);
    if ('reason' in r) rejected.push(r);
    else records.push({ ...r, snapshotAt: raw.snapshotAt });
  }
  return { records, rejected, rawCount: seen.size, snapshotAt: raw.snapshotAt };
}

export const OCM_MIN_RAW = 1000;

export function ocmHealth(result: AdapterResult, raw?: OcmRaw): HealthReport {
  const problems: string[] = [];
  if (result.rawCount < OCM_MIN_RAW) problems.push(`only ${result.rawCount} OCM records (expected at least ${OCM_MIN_RAW})`);
  if (raw && (!raw.ref.ConnectionTypes?.length || !raw.ref.Operators?.length)) problems.push('OCM reference data is missing its lookups');
  const noCoords = result.rejected.filter((r) => r.reason === 'no-coordinates').length;
  if (result.rawCount > 0 && noCoords / result.rawCount > 0.05) problems.push(`${noCoords} OCM records have no coordinates`);
  return { ok: problems.length === 0, problems };
}
