// Prints station counts per operator and per status from a published index.json (default public/data).
// Usage: node scripts/data-counts.ts [path/to/index.json] [--json]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const file = args.find((a) => !a.startsWith('--')) ?? 'public/data/index.json';
const idx = JSON.parse(readFileSync(file, 'utf8')) as {
  count: number;
  operators: string[];
  statuses: string[];
  speeds: string[];
  columns: { operator: Array<number | null>; status: number[]; speed: number[] };
};

const WATCH = ['HPCL', 'BPCL', 'Jio-bp pulse', 'Statiq', 'IndianOil', 'Tata Power EZ Charge', 'Shell Recharge', 'ChargeZone', 'Zeon Charging', 'Ather Grid'];
const byOperator: Record<string, number> = {};
const dcByOperator: Record<string, number> = {};
for (let i = 0; i < idx.count; i++) {
  const o = idx.columns.operator[i];
  const name = o === null || o === undefined ? '(unknown)' : idx.operators[o];
  byOperator[name] = (byOperator[name] ?? 0) + 1;
  if (idx.speeds[idx.columns.speed[i]] === 'dc') dcByOperator[name] = (dcByOperator[name] ?? 0) + 1;
}
const byStatus: Record<string, number> = {};
for (const s of idx.columns.status) byStatus[idx.statuses[s]] = (byStatus[idx.statuses[s]] ?? 0) + 1;

const out = {
  total: idx.count,
  watched: Object.fromEntries(WATCH.map((w) => [w, { all: byOperator[w] ?? 0, dc: dcByOperator[w] ?? 0 }])),
  byStatus,
  top: Object.entries(byOperator).sort((a, b) => b[1] - a[1]).slice(0, 25),
};
if (asJson) console.log(JSON.stringify(out));
else console.log(JSON.stringify(out, null, 2));
