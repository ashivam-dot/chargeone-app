// Compatibility wrapper: the data import now lives in pipeline/ (see pipeline/README.md).
// Usage (unchanged): node scripts/import-data.ts [--from-cache]
//   --from-cache  build from data-cache/ only (same as `npm run data:build`)
//   (no flag)     refresh every source first (same as `npm run data:build -- --refresh`)
// Prefer `npm run data:build` for new work.
import { main } from '../pipeline/build.ts';

const args = process.argv.slice(2);
const fromCache = args.includes('--from-cache');
const rest = args.filter((a) => a !== '--from-cache');

process.exitCode = await main(fromCache ? rest : ['--refresh', ...rest]);
