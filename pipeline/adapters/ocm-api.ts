// Open Charge Map through its API, once OCM_API_KEY is set (free key: openchargemap.org -> My Apps).
// Pages by id (sortby=id_asc&greaterthanid=N), the same way OCM builds its export, with an identifying
// User-Agent and a pause between pages. Compact output, joined with /v3/referencedata like the export.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, readJson, USER_AGENT, writeJson } from '../config.ts';
import { LICENCES } from '../licences.ts';
import type { Adapter } from '../types.ts';
import { ocmHealth, ocmToCanonical, type OcmCompactPoi, type OcmRaw, type OcmReferenceData } from './ocm.ts';

export const OCM_API = 'https://api.openchargemap.io/v3';
export const OCM_PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const CACHE_FILE = 'ocm-api.json';

export const ocmApiKey = () => process.env.OCM_API_KEY?.trim() || null;

interface Options {
  apiKey: string;
  fetchImpl?: typeof fetch;
  pauseMs?: number;
}

async function getJson<T>(url: URL, { apiKey, fetchImpl = fetch }: Options): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, 'X-API-Key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Open Charge Map ${url.pathname} HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchOcmApi(opts: Options): Promise<OcmRaw> {
  const ref = await getJson<OcmReferenceData>(new URL(`${OCM_API}/referencedata`), opts);
  const pois: OcmCompactPoi[] = [];
  let after = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${OCM_API}/poi`);
    url.search = new URLSearchParams({
      output: 'json',
      countrycode: 'IN',
      compact: 'true',
      verbose: 'false',
      includecomments: 'false',
      sortby: 'id_asc',
      greaterthanid: String(after),
      maxresults: String(OCM_PAGE_SIZE),
    }).toString();
    const batch = await getJson<OcmCompactPoi[]>(url, opts);
    if (!Array.isArray(batch)) throw new Error('Open Charge Map /poi did not return an array');
    pois.push(...batch);
    if (batch.length < OCM_PAGE_SIZE) break;
    const last = batch[batch.length - 1].ID;
    if (!(last > after)) throw new Error('Open Charge Map paging did not advance');
    after = last;
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  return { pois, ref, snapshotAt: new Date().toISOString(), origin: 'api' };
}

export const ocmApiAdapter: Adapter<OcmRaw> = {
  key: 'ocm',
  name: 'Open Charge Map (API)',
  licence: LICENCES['CC-BY-4.0'],
  async fetchRaw({ refresh }) {
    const file = join(CACHE_DIR, CACHE_FILE);
    if (!refresh && existsSync(file)) return readJson<OcmRaw>(file);
    const apiKey = ocmApiKey();
    if (!apiKey) throw new Error('OCM_API_KEY is not set');
    const raw = await fetchOcmApi({ apiKey, pauseMs: 1000 });
    await writeJson(file, raw);
    return raw;
  },
  toCanonical: ocmToCanonical,
  health: (result) => ocmHealth(result),
};
