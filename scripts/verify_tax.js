// verify_tax.js — independent read-back verification of the Phase 1 tax backfill.
// Prints COUNTS and category names only — no amounts (financial-data hygiene).
// Usage: node scripts/verify_tax.js
import { sheetsClient } from './tax_ledger.js';

// DEPRECATED-TAB GUARD (2026-09-21): LLC Transactions is retired. Expenses+Revenue
// are the only maintained tabs. This script targets the OLD tab and must not run
// unless you explicitly override with --force-legacy.
if (!process.argv.includes('--force-legacy')) {
  console.error('REFUSING: this script writes/reads the DEPRECATED LLC Transactions tab.');
  console.error('Use scripts/build_expenses_revenue.js / shopify_payouts.js / run_month.js — they target Expenses+Revenue directly.');
  console.error('Only pass --force-legacy if Enrique explicitly asks for legacy-tab surgery.');
  process.exit(1);
}


const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const FROM = '2026-01-01';
const TO = new Date().toISOString().slice(0, 10);

const meta = await sheets.spreadsheets.get({ spreadsheetId: LLC });
const tab = meta.data.sheets.find(s => s.properties.title === 'LLC Transactions');
const lastRow = tab.properties.gridProperties.rowCount;
const grid = await sheets.spreadsheets.values.get({
  spreadsheetId: LLC, range: `LLC Transactions!A2:AB${lastRow}`, valueRenderOption: 'UNFORMATTED_VALUE',
});
const rows = (grid.data.values || []).map((r, i) => ({ n: i + 2, r: r || [] }));

const epoch = Date.UTC(1899, 11, 30);
const inWindow = [];
for (const x of rows) {
  const serial = x.r[1];
  if (!(typeof serial === 'number' && serial > 20000)) continue;
  const iso = new Date(epoch + serial * 86400000).toISOString().slice(0, 10);
  if (iso >= FROM && iso <= TO) inWindow.push(x);
}

let stamped = 0, unstamped = 0;
const byType = {}, byLine = {}, byBusUse = {}, byReview = {};
let personal = 0, cogs = 0, income = 0, expense = 0;
for (const x of inWindow) {
  const r = x.r;
  const type = String(r[20] ?? '').trim();       // U
  if (!type) { unstamped++; continue; }
  stamped++;
  byType[type] = (byType[type] || 0) + 1;
  const line = String(r[21] ?? '(none)').trim() || '(none)'; // V
  byLine[line] = (byLine[line] || 0) + 1;
  const bu = String(r[23] ?? '').trim();          // X
  byBusUse[bu || '(blank)'] = (byBusUse[bu || '(blank)'] || 0) + 1;
  if (bu === 'personal') personal++;
  if (type === 'COGS') cogs++;
  else if (type === 'Income' || type === 'Refund') income++;
  else expense++;
  const rev = String(r[25] ?? '').trim() === 'Y'; // Z
  byReview[rev ? 'Needs-Review' : 'auto'] = (byReview[rev ? 'Needs-Review' : 'auto'] || 0) + 1;
}

let txids = 0;
for (const x of rows) if (x.n >= 4 && String(x.r[27] ?? '').trim()) txids++; // AB, data rows only

console.log(`Tax-layer verification (${FROM} → ${TO})`);
console.log(`  rows in window:            ${inWindow.length}`);
console.log(`  with tax stamp (U filled): ${stamped}`);
console.log(`  without stamp:             ${unstamped}`);
console.log(`  plaid tx-ids present (AB): ${txids}`);
console.log(`  by type:`, byType);
console.log(`  by Schedule C line:`, byLine);
console.log(`  business-use:`, byBusUse);
console.log(`  review:`, byReview);
console.log(`TOTALS: expense=${expense} income/refund=${income} cogs=${cogs} personal-flagged=${personal}`);
const ok = unstamped === 0;
console.log(ok ? 'VERIFICATION OK — every in-window row carries a tax stamp' : `VERIFICATION INCOMPLETE — ${unstamped} unstamped rows remain`);
process.exit(ok ? 0 : 1);
