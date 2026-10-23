// SQL that keeps driver reports attached to their charger when its id changes.
//
// Reports are stored under the charger's stable c1_ id. Older reports used OpenStreetMap / Open Charge
// Map ids (osm-n123, ocm-456), and a rebuild can retire a c1_ id when two records turn out to be one
// charger. The alias buckets in public/data/aliases/ (see src/data/lookup.ts) map every such id to the
// current c1_ id. This script turns them into rows for the station_alias table plus an UPDATE that moves
// reports onto the current ids. A c1_ id that comes back to life (a merge that split again) is deleted
// from the table first, so its reports stay its own.
//
//   node scripts/station-alias-sql.ts --migration   rewrites worker/migrations/0006_station_alias.sql
//   node scripts/station-alias-sql.ts --out <file>  writes a re-runnable sync file for
//                                                   `wrangler d1 execute chargeone --remote --file <file>`
//                                                   (`npm run deploy` runs it after every deploy)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AliasBucket } from '../src/data/lookup.ts';

const ROOT = new URL('../', import.meta.url);
const CHUNK = 200;
const ID = /^(c1_[a-z2-7]{12}|osm-[nwr]\d{1,15}|ocm-\d{1,10})$/;
const LIST_RECORD_ID = /^(tg|ovt)-[\w-]{1,64}$/;

interface AliasFile {
  version: string;
  aliases: Record<string, string>;
  /** Current c1 ids. */
  live?: string[];
}

/** Every alias and live id from the published alias buckets. */
export function readAliasBuckets(dir: URL): AliasFile {
  const out: AliasFile = { version: '', aliases: {}, live: [] };
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const b = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as AliasBucket;
    out.version = b.version;
    Object.assign(out.aliases, b.aliases);
    out.live!.push(...Object.keys(b.cells));
  }
  out.live!.sort();
  return out;
}

export function aliasSql(file: AliasFile, withTable: boolean): string {
  // Record ids of the location lists (`tg-…` Telangana, `ovt-…` Overture) never reach check-ins or links:
  // stations only they know use their c1 id. They resolve in the alias buckets but have no place in D1.
  const pairs = Object.entries(file.aliases)
    .filter(([from]) => !LIST_RECORD_ID.test(from))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [from, to] of pairs) {
    if (!ID.test(from) || !ID.test(to)) throw new Error(`Bad id in the alias files: ${from} -> ${to}`);
  }
  const live = new Set(file.live ?? []);
  for (const [from] of pairs) if (live.has(from)) throw new Error(`${from} is both a live station and an alias`);
  const out: string[] = [];
  if (withTable) {
    out.push(
      '-- Every id a charger was known by (osm-/ocm- ids and retired c1_ ids) and its current stable c1_ id.',
      `-- Seeded from public/data/aliases/ version ${file.version} by scripts/station-alias-sql.ts, which`,
      '-- also writes the re-runnable sync for later data builds.',
      'CREATE TABLE station_alias (',
      '  alias TEXT PRIMARY KEY,',
      '  station_id TEXT NOT NULL',
      ') WITHOUT ROWID;',
      '',
    );
  } else {
    out.push(`-- station_alias sync from public/data/aliases/ version ${file.version}. Safe to run more than once.`);
    // Ids that are live stations again stop being aliases.
    const ids = [...live].filter((id) => ID.test(id));
    for (let i = 0; i < ids.length; i += CHUNK) {
      out.push(`DELETE FROM station_alias WHERE alias IN (${ids.slice(i, i + CHUNK).map((id) => `'${id}'`).join(',')});`);
    }
  }
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const rows = pairs.slice(i, i + CHUNK).map(([from, to]) => `('${from}','${to}')`);
    out.push(`INSERT OR REPLACE INTO station_alias (alias, station_id) VALUES\n${rows.join(',\n')};`);
  }
  out.push(
    '',
    '-- Move reports stored under an old id onto the current one.',
    'UPDATE checkins SET station_id = (SELECT a.station_id FROM station_alias a WHERE a.alias = checkins.station_id)',
    'WHERE station_id IN (SELECT alias FROM station_alias);',
    '',
  );
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = readAliasBuckets(new URL('public/data/aliases/', ROOT));
  if (args[0] === '--migration') {
    const target = new URL('worker/migrations/0006_station_alias.sql', ROOT);
    writeFileSync(target, aliasSql(file, true));
    console.log(`Wrote ${target.pathname} (${Object.keys(file.aliases).length} aliases)`);
  } else if (args[0] === '--out' && args[1]) {
    mkdirSync(dirname(args[1]), { recursive: true });
    writeFileSync(args[1], aliasSql(file, false));
    console.log(`Wrote ${args[1]} (${Object.keys(file.aliases).length} aliases)`);
  } else {
    console.error('Usage: node scripts/station-alias-sql.ts --migration | --out <file>');
    process.exitCode = 1;
  }
}
