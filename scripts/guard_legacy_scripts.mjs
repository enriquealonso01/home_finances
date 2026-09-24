import fs from 'node:fs';

// Guard: refuse to touch the deprecated LLC Transactions tab unless --force-legacy.
for (const f of ['scripts/backfill_tax.js', 'scripts/ingest_statement_rows.mjs', 'scripts/verify_tax.js']) {
  let s = fs.readFileSync(f, 'utf-8');
  if (s.includes('DEPRECATED-TAB GUARD')) { console.log(f, 'already guarded'); continue; }
  const guard = `
// DEPRECATED-TAB GUARD (2026-09-21): LLC Transactions is retired. Expenses+Revenue
// are the only maintained tabs. This script targets the OLD tab and must not run
// unless you explicitly override with --force-legacy.
if (!process.argv.includes('--force-legacy')) {
  console.error('REFUSING: this script writes/reads the DEPRECATED LLC Transactions tab.');
  console.error('Use scripts/build_expenses_revenue.js / shopify_payouts.js / run_month.js — they target Expenses+Revenue directly.');
  console.error('Only pass --force-legacy if Enrique explicitly asks for legacy-tab surgery.');
  process.exit(1);
}
`;
  // insert right after the first import block (after last top-of-file import line)
  const lines = s.split('\n');
  let lastImport = 0;
  for (let i = 0; i < Math.min(lines.length, 30); i++) if (/^import /.test(lines[i])) lastImport = i;
  lines.splice(lastImport + 1, 0, guard);
  fs.writeFileSync(f, lines.join('\n'));
  console.log(f, 'guarded');
}
