// Open Charge Map from its free GitHub export (https://github.com/openchargemap/ocm-export): one JSON
// file per POI in data/IN plus data/referencedata.json. Used until the OCM API key arrives; the export
// lags the live data (last commit 2026-04-22 when this was written), so manifest.json records its date.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from '../config.ts';
import { LICENCES } from '../licences.ts';
import type { Adapter } from '../types.ts';
import { ocmHealth, ocmToCanonical, type OcmCompactPoi, type OcmRaw, type OcmReferenceData } from './ocm.ts';

export const OCM_EXPORT_REPO = 'https://github.com/openchargemap/ocm-export';
export const ocmExportDir = () => join(CACHE_DIR, 'ocm-export');

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Shallow, sparse clone of only India and the reference data (the full export is about 1.2 GB checked out). */
function cloneOrUpdate(dir: string): void {
  if (!existsSync(dir)) {
    git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', OCM_EXPORT_REPO, dir]);
    git(['sparse-checkout', 'set', '--no-cone', '/data/IN/', '/data/referencedata.json', '/README.md'], dir);
    return;
  }
  git(['pull', '--ff-only', '--depth', '1'], dir);
}

export async function readOcmExport(dir: string): Promise<OcmRaw> {
  const ref = JSON.parse(await readFile(join(dir, 'data', 'referencedata.json'), 'utf8')) as OcmReferenceData;
  const countryDir = join(dir, 'data', 'IN');
  const files = (await readdir(countryDir)).filter((f) => f.endsWith('.json')).sort();
  const pois: OcmCompactPoi[] = [];
  for (const f of files) pois.push(JSON.parse(await readFile(join(countryDir, f), 'utf8')) as OcmCompactPoi);
  let snapshotAt: string | null = null;
  try {
    snapshotAt = git(['log', '-1', '--format=%cI'], dir) || null;
  } catch {
    snapshotAt = null;
  }
  return { pois, ref, snapshotAt, origin: 'export' };
}

export const ocmExportAdapter: Adapter<OcmRaw> = {
  key: 'ocm',
  name: 'Open Charge Map (GitHub export)',
  licence: LICENCES['CC-BY-4.0'],
  async fetchRaw({ refresh }) {
    const dir = ocmExportDir();
    if (refresh || !existsSync(dir)) cloneOrUpdate(dir);
    return readOcmExport(dir);
  },
  toCanonical: ocmToCanonical,
  health: (result) => ocmHealth(result),
};
