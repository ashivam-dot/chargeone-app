// SQL that keeps driver reports attached to their charger when its id changes.
//
// Reports are stored under the charger's stable c1_ id. Older reports used OpenStreetMap / Open Charge
// Map ids (osm-n123, ocm-456), and a rebuild can retire a c1_ id when two records turn out to be one
// charger. public/data/aliases.json maps every such id to the current c1_ id. This script turns it into
// rows for the station_alias table plus an UPDATE that moves reports onto the current ids.
//
//   node scripts/station-alias-sql.ts --migration   rewrites worker/migrations/0006_station_alias.sql
//   node scripts/station-alias-sql.ts --out <file>  writes a re-runnable sync file for
//                                                   `wrangler d1 execute chargeone --file <file>`
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const CHUNK = 200;
const ID = /^(c1_[a-z2-7]{12}|osm-[nwr]\d{1,15}|ocm-\d{1,10})$/;

interface AliasFile {
  version: string;
  aliases: Record<string, string>;
}

export function aliasSql(file: AliasFile, withTable: boolean): string {
  const pairs = Object.entries(file.aliases).sort(([a], [b]) => a.localeCompare(b));
  for (const [from, to] of pairs) {
    if (!ID.test(from) || !ID.test(to)) throw new Error(`Bad id in aliases.json: ${from} -> ${to}`);
  }
  const out: string[] = [];
  if (withTable) {
    out.push(
      '-- Every id a charger was known by (osm-/ocm- ids and retired c1_ ids) and its current stable c1_ id.',
      `-- Seeded from public/data/aliases.json version ${file.version} by scripts/station-alias-sql.ts, which`,
      '-- also writes the re-runnable sync for later data builds.',
      'CREATE TABLE station_alias (',
      '  alias TEXT PRIMARY KEY,',
      '  station_id TEXT NOT NULL',
      ') WITHOUT ROWID;',
      '',
    );
  } else {
    out.push(`-- station_alias sync from public/data/aliases.json version ${file.version}. Safe to run more than once.`);
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
  const file = JSON.parse(readFileSync(new URL('public/data/aliases.json', ROOT), 'utf8')) as AliasFile;
  if (args[0] === '--migration') {
    const target = new URL('worker/migrations/0006_station_alias.sql', ROOT);
    writeFileSync(target, aliasSql(file, true));
    console.log(`Wrote ${target.pathname} (${Object.keys(file.aliases).length} aliases)`);
  } else if (args[0] === '--out' && args[1]) {
    writeFileSync(args[1], aliasSql(file, false));
    console.log(`Wrote ${args[1]} (${Object.keys(file.aliases).length} aliases)`);
  } else {
    console.error('Usage: node scripts/station-alias-sql.ts --migration | --out <file>');
    process.exitCode = 1;
  }
}
