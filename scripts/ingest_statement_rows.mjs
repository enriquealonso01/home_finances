#!/usr/bin/env node
// ingest_statement_rows.mjs — append statement-parsed rows (Jan 1–Mar 7/8 2026, the
// pre-Plaid window) into LLC Transactions General-Expenses section + tax stamps.
// Idempotent via ref id in column AB. Run without --apply for dry run.
import fs from 'node:fs';
import { sheetsClient, dateToSerial, applyTaxRules } from './tax_ledger.js';

// DEPRECATED-TAB GUARD (2026-09-21): LLC Transactions is retired. Expenses+Revenue
// are the only maintained tabs. This script targets the OLD tab and must not run
// unless you explicitly override with --force-legacy.
if (!process.argv.includes('--force-legacy')) {
  console.error('REFUSING: this script writes/reads the DEPRECATED LLC Transactions tab.');
  console.error('Use scripts/build_expenses_revenue.js / shopify_payouts.js / run_month.js — they target Expenses+Revenue directly.');
  console.error('Only pass --force-legacy if Enrique explicitly asks for legacy-tab surgery.');
  process.exit(1);
}


const apply = process.argv.includes('--apply');
const rows = JSON.parse(fs.readFileSync('/tmp/ingest_rows.json', 'utf8'));
const all = [...rows.expenses, ...rows.revenue];

// ambiguous personal-vs-business descriptions get forced Review=Y (Enrique tags personal ones)
const AMBIG = /toscana|wayfair|fiverr|aria|mandalay|american air|nic\*-dos|river landing shops|amazon\.com\*|amazon mktpl|amazon prime|prime video|7-eleven|ficelle|shake shack|lyft/i;

const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const meta = await sheets.spreadsheets.get({ spreadsheetId: LLC });
const tab = meta.data.sheets.find(s => s.properties.title === 'LLC Transactions');
const LAST_ROW = tab.properties.gridProperties.rowCount;

const grid = await sheets.spreadsheets.values.get({
  spreadsheetId: LLC, range: `LLC Transactions!A2:AB${LAST_ROW}`, valueRenderOption: 'UNFORMATTED_VALUE',
});
const existing = new Set();
(grid.data.values || []).forEach(r => { if (r && r[27]) existing.add(String(r[27])); });

const toAppend = [];
for (const r of all) {
  if (existing.has(r.ref)) continue;
  const tax = applyTaxRules({ internal: null, sheetCategory: null, merchant: r.desc, description: r.desc });
  const isRefund = r.amount < 0;
  let type = isRefund ? 'Refund' : 'Expense';
  if (tax.line === 'P1') type = isRefund ? 'Refund' : 'Income';
  const needsReview = !!tax.review || AMBIG.test(r.desc);
  const row = new Array(28).fill('');
  row[1] = dateToSerial(r.date);           // B
  row[2] = r.amount;                        // C (refund negative — matches ledger convention)
  row[3] = r.desc;                          // D
  row[4] = tax.category || 'Needs Review';  // E
  row[5] = r.card;                          // F
  row[19] = type;                           // U Type
  row[20] = tax.line || '';                 // V SchC line
  row[21] = tax.turbotax || '';             // W
  row[22] = tax.bus_use || 'mixed-review';  // X
  row[23] = tax.pct ?? '';                  // Y
  row[24] = needsReview ? 'Y' : '';         // Z review
  row[25] = `statement backfill (${r.source_stmt.replace('doc_', '').slice(0, 30)}); pre-Plaid window`; // AA notes
  row[27] = r.ref;                          // AB idempotency key
  toAppend.push(row);
}

console.log(`rows to append: ${toAppend.length} (skipped ${all.length - toAppend.length} already present)`);
const byType = {};
for (const r of toAppend) byType[r[19]] = (byType[r[19]] || 0) + 1;
console.log('by type:', byType);
if (!apply) { console.log('DRY RUN — re-run with --apply'); process.exit(0); }

const needed = LAST_ROW + toAppend.length + 20;
if (tab.properties.gridProperties.rowCount < needed) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: LLC,
    requestBody: { requests: [{ appendDimension: { sheetId: tab.properties.sheetId, dimension: 'ROWS', length: toAppend.length + 50 } }] },
  });
}
const updates = toAppend.map((v, i) => ({
  range: `LLC Transactions!A${LAST_ROW + 1 + i}:AB${LAST_ROW + 1 + i}`, values: [v],
}));
for (let i = 0; i < updates.length; i += 400) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: LLC, requestBody: { valueInputOption: 'USER_ENTERED', data: updates.slice(i, i + 400) },
  });
}
console.log(`APPLIED: ${toAppend.length} rows written starting at row ${LAST_ROW + 1}`);
