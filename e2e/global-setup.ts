import { execFileSync } from 'node:child_process';

/**
 * Clears the local D1 rate-limit counters so repeated local runs (and demo recordings) don't use up the per-day
 * allowances, such as 10 feedback messages per IP. CI starts from a fresh database, and a non-local BASE_URL is
 * left alone.
 */
export default function globalSetup(): void {
  const base = new URL(process.env.BASE_URL ?? 'http://localhost:8787');
  if (process.env.CI === 'true' || !['localhost', '127.0.0.1'].includes(base.hostname)) return;
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--command', 'DELETE FROM rate_limits'], { stdio: 'ignore' });
}
