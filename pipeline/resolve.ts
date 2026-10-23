// Entity resolution: which source records describe the same station.
//
// Candidates come from geohash-7 blocks (a cell and its 8 neighbours, about 450 m across), within
// THRESHOLDS.candidateMetres. Each pair gets a log-odds score from distance, operator, name and
// connectors. Hard rules first: two different known operators never merge, nor does a two-wheeler
// point with a car charger (they may share a Site), nor do two numbered listings of one source ("Hub - 1",
// "Hub - 2"). The operator rule bends when a listing's title names the other operator (OCM files many
// stations under the wrong network) or two identically titled listings sit within TWIN_METRES. A
// missing operator is never a wildcard: it lowers the score instead. Joining clusters re-checks every
// rule across all members, so A~B and B~C can't chain two same-source listings with different names. Pairs at or above THRESHOLDS.autoMerge merge; pairs between
// THRESHOLDS.review and autoMerge go to the review queue for the admin console.
import { THRESHOLDS } from './config.ts';
import { connectorsCompatible, connectorsOf } from './lib/connectors.ts';
import { distanceMetres, geohash, geohashBlock } from './lib/geo.ts';
import { differentOperators, sameOperator } from './lib/operators.ts';
import { nameSimilarity, nameTokens } from './lib/text.ts';
import { vehicleClass, vehicleConflict } from './lib/vehicle.ts';
import type { CanonicalConnector, ReviewItem, SourceRecord, VehicleClass } from './types.ts';

const BLOCK_PRECISION = 7;
/** Different operators closer than this are listed for review (see resolve). */
const OPERATOR_CONFLICT_METRES = 25;
/** Identically titled listings this close are one charger, whatever operator each source files it under. */
const TWIN_METRES = 10;

interface Prepared {
  r: SourceRecord;
  index: number;
  tokens: Set<string>;
  connectors: CanonicalConnector[];
  vclass: VehicleClass;
  title: string;
  listing: number | null;
}

export interface PairScore {
  score: number;
  distanceM: number;
  /** Set when a hard rule forbids the merge. */
  blocked: string | null;
  reasons: string[];
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function prepare(r: SourceRecord, index: number): Prepared {
  return {
    r,
    index,
    tokens: nameTokens(r.name, r.operator),
    connectors: connectorsOf(r.evses),
    vclass: vehicleClass(r.vehicles),
    title: (r.name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
    listing: listingNumber(r.name),
  };
}

/** The number in "Statiq Hub - 2" or "Charger #3": one source listing each charger of a site separately. */
export function listingNumber(name: string | null): number | null {
  const m = name?.match(/(?:\s[-–—#]\s*|\s(?:no\.?|unit|charger|point|gun)\s*#?\s*)(\d{1,3})\s*\)?\s*$/i);
  return m ? Number(m[1]) : null;
}

/** Two numbered listings of one source with different numbers are different chargers. */
function distinctListings(a: Prepared, b: Prepared): boolean {
  return a.r.source === b.r.source && a.listing !== null && b.listing !== null && a.listing !== b.listing;
}

/**
 * Known, different operators that nothing reconciles. A title naming the other record's operator, or the same
 * title within TWIN_METRES, says one of the two sources filed the charger under the wrong network.
 */
function operatorClash(a: Prepared, b: Prepared, d: number): boolean {
  if (!differentOperators(a.r.operator, b.r.operator)) return false;
  if (sameOperator(a.r.titleOperator ?? null, b.r.operator) || sameOperator(b.r.titleOperator ?? null, a.r.operator)) return false;
  return !(a.title !== '' && a.title === b.title && d <= TWIN_METRES);
}

/** Two records of one source with different names (or listing numbers) are two listings, never one station. */
function sameSourceDistinct(a: Prepared, b: Prepared): boolean {
  if (a.r.source !== b.r.source) return false;
  if (distinctListings(a, b)) return true;
  const sim = nameSimilarity(a.tokens, b.tokens);
  return sim !== null && sim < 0.5;
}

export function scorePair(a: SourceRecord, b: SourceRecord): PairScore {
  return scorePrepared(prepare(a, 0), prepare(b, 1));
}

function scorePrepared(a: Prepared, b: Prepared): PairScore {
  const d = distanceMetres(a.r, b.r);
  const reasons: string[] = [`${Math.round(d)} m apart`];
  if (operatorClash(a, b, d)) {
    return { score: 0, distanceM: d, blocked: `different operators (${a.r.operator} / ${b.r.operator})`, reasons };
  }
  if (distinctListings(a, b)) {
    return { score: 0, distanceM: d, blocked: `numbered listings ${a.listing} / ${b.listing}`, reasons };
  }
  if (vehicleConflict(a.vclass, b.vclass)) {
    return { score: 0, distanceM: d, blocked: `vehicle classes differ (${a.vclass} / ${b.vclass})`, reasons };
  }
  const sigma = THRESHOLDS.distanceSigmaMetres;
  let logit = -0.5 + 4 * Math.exp(-0.5 * (d / sigma) ** 2) - 1.5;

  if (sameOperator(a.r.operator, b.r.operator)) {
    logit += 2.5;
    reasons.push(`same operator (${a.r.operator})`);
  } else if (differentOperators(a.r.operator, b.r.operator)) {
    logit -= 0.5;
    reasons.push(`operators disagree (${a.r.operator} / ${b.r.operator}), title reconciles them`);
  } else if (a.r.operator !== null || b.r.operator !== null) {
    logit -= 0.5;
    reasons.push('one operator unknown');
  } else {
    reasons.push('both operators unknown');
  }

  const sim = nameSimilarity(a.tokens, b.tokens);
  if (sim !== null) {
    if (sim >= 0.8) logit += 2;
    else if (sim >= 0.5) logit += 1;
    else if (sim < 0.2) logit -= 1.5;
    reasons.push(`name similarity ${sim.toFixed(2)}`);
  }

  const compatible = connectorsCompatible(a.connectors, b.connectors);
  if (compatible === true) {
    logit += 0.75;
    reasons.push('connectors overlap');
  } else if (compatible === false) {
    logit -= 2;
    reasons.push('connectors differ');
  }
  let score = sigmoid(logit);
  // Two records in one source with different names are two listings by the same editor or import, usually
  // two businesses geocoded to one point. Never merge them unseen; a person decides.
  if (a.r.source === b.r.source && sim !== null && sim < 0.5 && score >= THRESHOLDS.autoMerge) {
    score = THRESHOLDS.autoMerge - 0.01;
    reasons.push('same source, different names: review');
  }
  return { score, distanceM: d, blocked: null, reasons };
}

export interface Candidate {
  i: number;
  j: number;
  pair: PairScore;
}

/** All scored pairs within the candidate radius, blocked by geohash-7. */
export function candidatePairs(records: SourceRecord[], prepared: Prepared[] = records.map(prepare)): Candidate[] {
  const cells = new Map<string, number[]>();
  for (const p of prepared) {
    const cell = geohash(p.r.lat, p.r.lng, BLOCK_PRECISION);
    let list = cells.get(cell);
    if (!list) cells.set(cell, (list = []));
    list.push(p.index);
  }
  const out: Candidate[] = [];
  for (const p of prepared) {
    for (const cell of geohashBlock(p.r.lat, p.r.lng, BLOCK_PRECISION)) {
      for (const j of cells.get(cell) ?? []) {
        if (j <= p.index) continue;
        const q = prepared[j];
        if (distanceMetres(p.r, q.r) > THRESHOLDS.candidateMetres) continue;
        out.push({ i: p.index, j, pair: scorePrepared(p, q) });
      }
    }
  }
  return out;
}

class Clusters {
  parent: number[];
  members: number[][];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.members = Array.from({ length: n }, (_, i) => [i]);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    this.parent[drop] = keep;
    this.members[keep].push(...this.members[drop]);
    this.members[drop] = [];
  }
}

/**
 * Would joining these two clusters put two operators, a 2W point and a car charger, or two distinct listings
 * of one source in one station? Every cross pair is checked, not just the pair that scored.
 */
function clusterConflict(prepared: Prepared[], a: number[], b: number[]): string | null {
  for (const i of a) {
    for (const j of b) {
      const x = prepared[i];
      const y = prepared[j];
      const d = distanceMetres(x.r, y.r);
      if (operatorClash(x, y, d)) return `different operators (${x.r.operator} / ${y.r.operator})`;
      if (vehicleConflict(x.vclass, y.vclass)) return `vehicle classes differ (${x.vclass} / ${y.vclass})`;
      if (sameSourceDistinct(x, y)) return `same source, different listings (${x.r.name} / ${y.r.name})`;
      if (d > THRESHOLDS.candidateMetres) return 'cluster would span too far';
    }
  }
  return null;
}

export interface ReviewPair {
  kind: ReviewItem['kind'];
  /** The same record twice for a single-listing item (a title naming another network). */
  i: number;
  j: number;
  score: number;
  distanceM: number;
  reasons: string[];
}

export interface Resolution {
  /** Each cluster is a list of record indexes; one cluster becomes one station. */
  clusters: number[][];
  review: ReviewPair[];
  /** Pairs a hard rule kept apart within the candidate radius (for metrics and tests). */
  blocked: Array<{ i: number; j: number; reason: string }>;
}

export function resolve(records: SourceRecord[]): Resolution {
  const prepared = records.map(prepare);
  const pairs = candidatePairs(records, prepared).sort(
    (x, y) => y.pair.score - x.pair.score || records[x.i].sourceId.localeCompare(records[y.i].sourceId) || records[x.j].sourceId.localeCompare(records[y.j].sourceId),
  );
  const uf = new Clusters(records.length);
  const blocked: Resolution['blocked'] = [];
  const pending: Candidate[] = [];
  for (const c of pairs) {
    if (c.pair.blocked) {
      blocked.push({ i: c.i, j: c.j, reason: c.pair.blocked });
      continue;
    }
    if (c.pair.score < THRESHOLDS.autoMerge) {
      if (c.pair.score >= THRESHOLDS.review) pending.push(c);
      continue;
    }
    const ra = uf.find(c.i);
    const rb = uf.find(c.j);
    if (ra === rb) continue;
    const conflict = clusterConflict(prepared, uf.members[ra], uf.members[rb]);
    if (conflict) {
      pending.push({ ...c, pair: { ...c.pair, reasons: [...c.pair.reasons, `not merged: ${conflict}`] } });
      continue;
    }
    uf.union(c.i, c.j);
  }

  // One review item per pair of resulting stations, keeping the strongest pair.
  const review = new Map<string, ReviewPair>();
  for (const c of pending) {
    const ra = uf.find(c.i);
    const rb = uf.find(c.j);
    if (ra === rb) continue;
    const key = ra < rb ? `${ra}:${rb}` : `${rb}:${ra}`;
    const prev = review.get(key);
    if (!prev || c.pair.score > prev.score)
      review.set(key, { kind: 'possible-duplicate', i: c.i, j: c.j, score: c.pair.score, distanceM: c.pair.distanceM, reasons: c.pair.reasons });
  }
  // Two operators listed at the same spot: often an owner and the app network that runs it (KSEB and
  // chargeMOD), sometimes a wrong operator. They stay separate stations on one Site; a person can check.
  for (const c of pairs) {
    if (!c.pair.blocked?.startsWith('different operators') || c.pair.distanceM > OPERATOR_CONFLICT_METRES) continue;
    const ra = uf.find(c.i);
    const rb = uf.find(c.j);
    const key = ra < rb ? `${ra}:${rb}` : `${rb}:${ra}`;
    if (!review.has(key)) review.set(key, { kind: 'operator-conflict', i: c.i, j: c.j, score: 0, distanceM: c.pair.distanceM, reasons: [...c.pair.reasons, c.pair.blocked] });
  }

  // A title naming another network that no nearby record of that network confirms: which one is right?
  records.forEach((r, i) => {
    if (!r.titleOperator) return;
    const root = uf.find(i);
    if (uf.members[root].some((k) => sameOperator(records[k].operator, r.titleOperator ?? null))) return;
    review.set(`title:${i}`, {
      kind: 'operator-title',
      i,
      j: i,
      score: 0,
      distanceM: 0,
      reasons: [`listed under ${r.operator}, title names ${r.titleOperator}`],
    });
  });

  const clusters = uf.members
    .filter((m) => m.length > 0)
    .map((m) => m.sort((x, y) => records[x].sourceId.localeCompare(records[y].sourceId)));
  return { clusters, review: [...review.values()].sort((x, y) => y.score - x.score || x.distanceM - y.distanceM), blocked };
}

/** Groups stations closer than THRESHOLDS.siteMetres into Sites (different operators at one car park). */
export function groupSites(points: Array<{ lat: number; lng: number }>): number[][] {
  const uf = new Clusters(points.length);
  const cells = new Map<string, number[]>();
  points.forEach((p, i) => {
    const cell = geohash(p.lat, p.lng, BLOCK_PRECISION);
    (cells.get(cell) ?? cells.set(cell, []).get(cell)!).push(i);
  });
  points.forEach((p, i) => {
    for (const cell of geohashBlock(p.lat, p.lng, BLOCK_PRECISION)) {
      for (const j of cells.get(cell) ?? []) if (j > i && distanceMetres(p, points[j]) <= THRESHOLDS.siteMetres) uf.union(i, j);
    }
  });
  return uf.members.filter((m) => m.length > 0).map((m) => m.sort((a, b) => a - b));
}
