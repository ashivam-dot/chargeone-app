// Entity resolution: which source records describe the same station.
//
// Candidates come from geohash-7 blocks (a cell and its 8 neighbours, about 450 m across), within
// THRESHOLDS.candidateMetres. Each pair gets a log-odds score from distance, operator, name and
// connectors. Hard rules first: two different known operators never merge, nor does a two-wheeler
// point with a car charger (they may share a Site). A missing operator is never a wildcard: it
// lowers the score instead. Pairs at or above THRESHOLDS.autoMerge merge; pairs between
// THRESHOLDS.review and autoMerge go to the review queue for the admin console.
import { THRESHOLDS } from './config.ts';
import { connectorsCompatible, connectorsOf } from './lib/connectors.ts';
import { distanceMetres, geohash, geohashBlock } from './lib/geo.ts';
import { differentOperators, sameOperator } from './lib/operators.ts';
import { nameSimilarity, nameTokens } from './lib/text.ts';
import { vehicleClass, vehicleConflict } from './lib/vehicle.ts';
import type { CanonicalConnector, SourceRecord, VehicleClass } from './types.ts';

const BLOCK_PRECISION = 7;
/** Different operators closer than this are listed for review (see resolve). */
const OPERATOR_CONFLICT_METRES = 25;

interface Prepared {
  r: SourceRecord;
  index: number;
  tokens: Set<string>;
  connectors: CanonicalConnector[];
  vclass: VehicleClass;
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
  return { r, index, tokens: nameTokens(r.name, r.operator), connectors: connectorsOf(r.evses), vclass: vehicleClass(r.vehicles) };
}

export function scorePair(a: SourceRecord, b: SourceRecord): PairScore {
  return scorePrepared(prepare(a, 0), prepare(b, 1));
}

function scorePrepared(a: Prepared, b: Prepared): PairScore {
  const d = distanceMetres(a.r, b.r);
  const reasons: string[] = [`${Math.round(d)} m apart`];
  if (differentOperators(a.r.operator, b.r.operator)) {
    return { score: 0, distanceM: d, blocked: `different operators (${a.r.operator} / ${b.r.operator})`, reasons };
  }
  if (vehicleConflict(a.vclass, b.vclass)) {
    return { score: 0, distanceM: d, blocked: `vehicle classes differ (${a.vclass} / ${b.vclass})`, reasons };
  }
  const sigma = THRESHOLDS.distanceSigmaMetres;
  let logit = -0.5 + 4 * Math.exp(-0.5 * (d / sigma) ** 2) - 1.5;

  if (sameOperator(a.r.operator, b.r.operator)) {
    logit += 2.5;
    reasons.push(`same operator (${a.r.operator})`);
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
export function candidatePairs(records: SourceRecord[]): Candidate[] {
  const prepared = records.map(prepare);
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

/** Would joining these two clusters put two operators or a 2W point and a car charger in one station? */
function clusterConflict(records: SourceRecord[], a: number[], b: number[]): string | null {
  const all = [...a, ...b].map((i) => records[i]);
  const ops = all.map((r) => r.operator).filter((o): o is string => o !== null);
  for (const o of ops) if (differentOperators(o, ops[0])) return `different operators (${ops[0]} / ${o})`;
  const classes = all.map((r) => vehicleClass(r.vehicles));
  for (const c of classes) for (const d of classes) if (vehicleConflict(c, d)) return `vehicle classes differ (${c} / ${d})`;
  for (const x of all) for (const y of all) if (distanceMetres(x, y) > THRESHOLDS.candidateMetres) return 'cluster would span too far';
  return null;
}

export interface ReviewPair {
  kind: 'possible-duplicate' | 'operator-conflict';
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
  const pairs = candidatePairs(records).sort(
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
    const conflict = clusterConflict(records, uf.members[ra], uf.members[rb]);
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
    cells.set(cell, [...(cells.get(cell) ?? []), i]);
  });
  points.forEach((p, i) => {
    for (const cell of geohashBlock(p.lat, p.lng, BLOCK_PRECISION)) {
      for (const j of cells.get(cell) ?? []) if (j > i && distanceMetres(p, points[j]) <= THRESHOLDS.siteMetres) uf.union(i, j);
    }
  });
  return uf.members.filter((m) => m.length > 0).map((m) => m.sort((a, b) => a - b));
}
