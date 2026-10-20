// Owner's tool for direct UPI payments: list claims, then confirm or reject each one after checking
// the bank statement (match the UTR and the amount; the note shows the CO reference).
//
//   CHARGEONE_ADMIN_TOKEN=... node scripts/upi-admin.ts list [claimed|confirmed|rejected|created] [--api https://chargeone.in]
//   CHARGEONE_ADMIN_TOKEN=... node scripts/upi-admin.ts confirm CO23456789AB
//   CHARGEONE_ADMIN_TOKEN=... node scripts/upi-admin.ts reject CO23456789AB
//
// The token is the Worker secret ADMIN_TOKEN. It is read from the environment and never printed.

const args = process.argv.slice(2);
const apiIndex = args.indexOf('--api');
const api = apiIndex >= 0 ? args.splice(apiIndex, 2)[1] : 'http://127.0.0.1:8787';
const [command, value] = args;
const token = process.env.CHARGEONE_ADMIN_TOKEN;

if (!token) {
  console.error('Set CHARGEONE_ADMIN_TOKEN to the Worker ADMIN_TOKEN secret.');
  process.exit(2);
}

async function call(method: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined,
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`${res.status}: ${String(body.message ?? body.error)}`);
    process.exit(1);
  }
  return body;
}

if (command === 'list') {
  const { payments } = (await call('GET', `/api/admin/upi?status=${value ?? 'claimed'}`)) as { payments: Array<Record<string, string | number>> };
  if (payments.length === 0) console.log('Nothing here.');
  for (const p of payments) {
    const rupees = `₹${(Number(p.amount_paise) / 100).toFixed(0)}`;
    console.log([p.ref, p.status, p.plan, rupees, `UTR ${p.utr ?? '-'}`, p.email, p.claimed_at ?? p.created_at].join('  '));
  }
} else if ((command === 'confirm' || command === 'reject') && value) {
  const r = await call('POST', `/api/admin/upi/${encodeURIComponent(value)}/${command}`);
  console.log(`${r.ref}: ${r.status}`);
} else {
  console.error('Usage: node scripts/upi-admin.ts list [status] | confirm <ref> | reject <ref> [--api <url>]');
  process.exit(2);
}

export {};
