// A polite Overpass client for the build-time place imports (never run by users).
// Overpass is a donated service: we send an identifying User-Agent, run one query at a time, pause
// between queries, back off when a server is busy, and cache every answer so nothing is fetched twice.
import type { OsmElement } from '../src/data/normalize.ts';

export const OVERPASS_USER_AGENT = 'ChargeOne/0.2 (+https://chargeone.akshshivam5.workers.dev; EV trip planner for India)';
export const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
/** Pause between two queries, so a run is a trickle and not a burst. */
export const OVERPASS_PAUSE_MS = 4000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Overpass ran the query but it needed more time or memory than allowed; retrying won't help. */
export class QueryTooBig extends Error {}

/**
 * Runs one Overpass QL query. Tries each endpoint in turn and, when all are busy (429/502/503/504
 * or a timeout), waits and tries again: 30 s, 60 s, 120 s, 240 s. A query too big to finish throws
 * QueryTooBig at once, so the caller can split it.
 */
export async function overpass(query: string, timeoutSec: number): Promise<OsmElement[]> {
  const problems: string[] = [];
  for (let round = 0; round < 5; round++) {
    if (round) {
      const wait = 30_000 * 2 ** (round - 1);
      console.warn(`  every Overpass server is busy, waiting ${wait / 1000} s`);
      await sleep(wait);
    }
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': OVERPASS_USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout((timeoutSec + 60) * 1000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { elements?: OsmElement[]; remark?: string };
        // Overpass reports a query that ran out of time or memory as a remark on a 200 reply.
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new QueryTooBig(json.remark);
        if (!Array.isArray(json.elements)) throw new Error('response has no elements array');
        return json.elements;
      } catch (err) {
        if (err instanceof QueryTooBig) throw err;
        problems.push(`${endpoint}: ${String(err)}`);
        console.warn(`  ${endpoint} failed: ${String(err)}`);
      }
    }
  }
  throw new Error(`All Overpass endpoints failed:\n  ${problems.slice(-4).join('\n  ')}`);
}
