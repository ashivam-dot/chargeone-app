// Creates .dev.vars for `wrangler dev` with a random local session secret.
// The file is gitignored and the secret is never printed.
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const path = new URL('../.dev.vars', import.meta.url);
if (existsSync(path)) {
  console.log('.dev.vars already exists; leaving it unchanged.');
} else {
  const lines = [
    'ENVIRONMENT=development',
    `SESSION_SECRET=${randomBytes(32).toString('base64url')}`,
    '# Optional for real routing and payments (use test keys locally):',
    '# ORS_API_KEY=',
    '# RAZORPAY_KEY_SECRET=',
    '# RAZORPAY_WEBHOOK_SECRET=',
    '# Admin console (/admin): unset here, it accepts the public dev token chargeone-local-admin-dev-only.',
    '# Production needs its own: openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN',
    '# ADMIN_TOKEN=',
  ];
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  console.log('Created .dev.vars (development mode, local session secret).');
}
