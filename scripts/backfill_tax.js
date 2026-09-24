#!/usr/bin/env node
// backfill_tax.js — Phase 1: Schedule C tax layer over the LLC ledger.
//
//   node scripts/backfill_tax.js [--apply] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//
// Sheet layout (LLC Transactions tab is SECTIONED HORIZONTALLY — do NOT touch K:Q):
//   B..F  General Expenses: Date, Amount, Description, Category, Card Used
//   I..L  Equity:           Date, Amount, Description, Category
//   O..T  Revenue:          Date, Amount, Description, Category, Est. Taxes, After Taxes
// Tax stamp columns (this script): U..AA + AB (Plaid tx id)
//   U Type, V ScheduleC Line, W TurboTax, X BusUse, Y Pct, Z NeedsReview, AA Notes, AB txId
//
// Steps (TAX-PLAN.md Phase 1):
//  1. Read existing ledger rows, stamp tax columns U..AA in place for every row dated in-window.
//     Rows outside the window are left untouched. Legacy values in B..T are never written.
//  2. Pull Plaid transactions for the window from connected BUSINESS accounts, classify via
//     the two-layer engine, and append new rows into the General Expenses section (B..F)
//     with tax stamp columns U..AB. Idempotent via Plaid transaction_id in AB.
//  3. Counts only in output (no amounts). State -> data/tax_backfill_state.json (no amounts).
import fs from 'node:fs';
import path from 'node:path';
import {

// DEPRECATED-TAB GUARD (2026-09-21): LLC Transactions is retired. Expenses+Revenue
// are the only maintained tabs. This script targets the OLD tab and must not run
// unless you explicitly override with --force-legacy.
if (!process.argv.includes('--force-legacy')) {
  console.error('REFUSING: this script writes/reads the DEPRECATED LLC Transactions tab.');
  console.error('Use scripts/build_expenses_revenue.js / shopify_payouts.js / run_month.js — they target Expenses+Revenue directly.');
  console.error('Only pass --force-legacy if Enrique explicitly asks for legacy-tab surgery.');
  process.exit(1);
}

  ROOT, taxRules, pullPlaidTransactions, shouldSkipPlaid, buildLedgerRow,
  sheetsClient, dateToSerial, applyTaxRules,
} from './tax_ledger.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};

const TODAY = new Date().toISOString().slice(0, 10);
const FROM = argOf('--from', '2026-01-01');
const TO = argOf('--to', TODAY);

console.log(`LLC tax backfill ${FROM} → ${TO}  apply=${apply}`);

const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const RANGE_END = 1376; // last legacy row before appended block
const STAMP_START = 21; // column U (1-indexed)
const TXID_COL = 28;    // column AB

const stampRange = (row) => `LLC Transactions!U${row}:AA${row}`;
const stampHeader = ['Type', 'ScheduleC Line', 'TurboTax', 'BusUse', 'Pct', 'NeedsReview', 'Notes'];

// ─── 1. read existing ledger ─────────────────────────────────────────────────
const meta = await sheets.spreadsheets.get({ spreadsheetId: LLC });
const llcTab = meta.data.sheets.find(s => s.properties.title === 'LLC Transactions');
if (!llcTab) { console.error('LLC Transactions tab not found'); process.exit(1); }

const LAST_ROW = llcTab.properties.gridProperties.rowCount; // true sheet size (rows are dense)
const grid = await sheets.spreadsheets.values.get({
  spreadsheetId: LLC,
  range: `LLC Transactions!A2:AB${LAST_ROW}`,
  valueRenderOption: 'UNFORMATTED_VALUE',
});
const rows = (grid.data.values || []).map((r, i) => ({ n: i + 2, r: r || [] }));
const ledgerRows = rows.filter(x => x.r.some(c => c !== undefined && c !== null && c !== ''));
console.log(`Ledger rows with content (A:AB): ${ledgerRows.length}`);

const existingTxIds = new Set();
for (const x of ledgerRows) {
  const id = x.r[TXID_COL - 1];
  if (id) existingTxIds.add(String(id));
}

// ─── 2. stamp tax columns U..AA on existing rows in-window ───────────────────
const dataUpdates = [];
// header row for the stamp block (row 3, next to the other section headers)
dataUpdates.push({ range: `LLC Transactions!U3:AA3`, values: [stampHeader] });

let stamped = 0, alreadyStamped = 0, outOfWindow = 0, skippedEngineRows = 0;
for (const x of ledgerRows) {
  const r = x.r;
  const serial = r[1];
  if (!(typeof serial === 'number' && serial > 20000)) { outOfWindow++; continue; }
  const epoch = Date.UTC(1899, 11, 30);
  const d = new Date(epoch + serial * 86400000);
  const iso = d.toISOString().slice(0, 10);
  if (iso < FROM || iso > TO) { outOfWindow++; continue; }

  // Rows with an id in AB were appended by an engine path (Plaid backfill or Shopify payouts)
  // and were classified with full source data (merchant_name, PFC, payout summaries). The
  // stamping pass sees only the B..F text and would classify them WORSE (e.g. AutoDS
  // subscription-hint is invisible). Never restamp engine-owned rows; their owning paths are
  // idempotent. Stamping here is for legacy manually-entered rows (AB empty) only.
  if (String(r[TXID_COL - 1] ?? '') !== '') { skippedEngineRows++; continue; }

  const desc = String(r[3] || '');
  const sheetCat = String(r[4] || '');
  const amount = typeof r[2] === 'number' ? r[2] : parseFloat(String(r[2]).replace(/[$,]/g, '')) || 0;
  const isRefund = amount < 0;

  const tax = applyTaxRules({ internal: null, sheetCategory: sheetCat, merchant: desc, description: desc });
  let type = tax.type || (isRefund ? 'Refund' : 'Expense');
  if (tax.line === 'P1') type = isRefund ? 'Refund' : 'Income';
  const needsReview = !!tax.review;
  let notes = tax.part_v ? `Part V: ${tax.part_v}` : '';
  // Preserve pre-existing notes when the recompute yields none (e.g., payout_id audit notes
  // written by shopify_payouts.js) — never blank out another writer's notes.
  if (!notes && String(r[STAMP_START + 5] ?? '') !== '') notes = String(r[STAMP_START + 5]);

  const cur = {
    type: r[STAMP_START - 1], scline: r[STAMP_START], turbotax: r[STAMP_START + 1],
    bus_use: r[STAMP_START + 2], pct: r[STAMP_START + 3], review: r[STAMP_START + 4], notes: r[STAMP_START + 5],
  };
  const want = { type, scline: tax.line || '', turbotax: tax.turbotax || '', bus_use: tax.bus_use || 'mixed-review',
                 pct: tax.pct ?? '', review: needsReview ? 'Y' : '', notes };
  const changed = ['type', 'scline', 'turbotax', 'bus_use', 'pct', 'review', 'notes']
    .some(k => String(cur[k] ?? '') !== String(want[k] ?? ''));
  if (!changed) { alreadyStamped++; continue; }
  stamped++;
  dataUpdates.push({
    range: stampRange(x.n),
    values: [[want.type, want.scline, want.turbotax, want.bus_use, want.pct, want.review, want.notes]],
  });
}
console.log(`Tax stamping (U:AA): ${stamped} rows to update, ${alreadyStamped} already correct, ${outOfWindow} out of window / undated (left untouched), ${skippedEngineRows} engine-appended rows left to their own idempotent paths`);

// ─── 3. Plaid pull + classify ────────────────────────────────────────────────
console.log(`Pulling Plaid ${FROM} → ${TO} (business accounts only)…`);
const plaidTxns = await pullPlaidTransactions(FROM, TO, { businessOnly: true });
console.log(`Plaid pulled (business accounts): ${plaidTxns.length}`);

const ledgerAppends = [];
const seen = new Set();
let skippedTransfers = 0, skippedDupes = 0;
const byType = {}, byLine = {}, byCard = {};
let autoClassified = 0, needsReviewCount = 0;

for (const tx of plaidTxns.sort((a, b) => a.date.localeCompare(b.date))) {
  if (seen.has(tx.transaction_id)) continue;
  seen.add(tx.transaction_id);
  if (shouldSkipPlaid(tx)) { skippedTransfers++; continue; }
  if (existingTxIds.has(String(tx.transaction_id))) { skippedDupes++; continue; }
  if (tx.pending) continue; // only settled transactions

  const row = buildLedgerRow(tx);
  ledgerAppends.push(row);
  byType[row.type] = (byType[row.type] || 0) + 1;
  byLine[row.scline || '(none)'] = (byLine[row.scline || '(none)'] || 0) + 1;
  byCard[row.card] = (byCard[row.card] || 0) + 1;
  if (row.review === 'Y') needsReviewCount++; else autoClassified++;
}
console.log(`New ledger rows to append: ${ledgerAppends.length} (skipped ${skippedTransfers} transfers/non-purchases, ${skippedDupes} already in ledger)`);
console.log(`  auto-classified: ${autoClassified} | needs-review: ${needsReviewCount}`);
console.log(`  by type:`, byType);
console.log(`  by Schedule C line:`, byLine);
console.log(`  by card:`, byCard);

// ─── 4. write ────────────────────────────────────────────────────────────────
if (!apply) {
  console.log('\nDRY RUN — re-run with --apply to write.');
  process.exit(0);
}

// Appended rows: full-width General-Expenses entry + tax stamps, laid out per the
// sectioned design. B date, C amount, D description, E category, F card,
// U..AA stamp block, AB plaid txid. Columns G,H,I..T stay EMPTY (other sections).
const appendValues = ledgerAppends.map(r => {
  const row = new Array(TXID_COL).fill('');
  row[1] = dateToSerial(r.date);       // B serial date (matches column format)
  row[2] = r.amount;                    // C
  row[3] = r.description;               // D
  row[4] = r.category;                  // E
  row[5] = r.card;                      // F
  row[STAMP_START - 1] = r.type;        // U
  row[STAMP_START] = r.scline;          // V
  row[STAMP_START + 1] = r.turbotax;    // W
  row[STAMP_START + 2] = r.bus_use;     // X
  row[STAMP_START + 3] = r.pct;         // Y
  row[STAMP_START + 4] = r.review;      // Z
  row[STAMP_START + 5] = r.notes;       // AA
  row[TXID_COL - 1] = r.key;            // AB
  return row;
});

if (apply) {
  // ensure grid is tall enough
  const neededLastRow = LAST_ROW + appendValues.length + 20;
  if (llcTab.properties.gridProperties.rowCount < neededLastRow) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: LLC,
      requestBody: { requests: [{ appendDimension: { sheetId: llcTab.properties.sheetId, dimension: 'ROWS', length: appendValues.length + 50 } }] },
    });
  }
  const startRow = LAST_ROW + 1;
  const updates = appendValues.map((v, i) => ({
    range: `LLC Transactions!A${startRow + i}:AB${startRow + i}`,
    values: [v],
  }));
  for (let i = 0; i < updates.length; i += 400) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: LLC,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates.slice(i, i + 400) },
    });
  }
  console.log(`Wrote ${updates.length} rows at rows ${startRow}..${startRow + updates.length - 1}`);

  if (dataUpdates.length > 0) {
    for (let i = 0; i < dataUpdates.length; i += 400) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: LLC,
        requestBody: { valueInputOption: 'USER_ENTERED', data: dataUpdates.slice(i, i + 400) },
      });
    }
    console.log(`Stamped ${dataUpdates.length - 1} existing rows + 1 header row (U:AA).`);
  }
}

// state file (no amounts)
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/tax_backfill_state.json'), JSON.stringify({
  last_run: new Date().toISOString(),
  window: { from: FROM, to: TO },
  stamped: stamped,
  appended: ledgerAppends.length,
  by_type: byType,
  by_schedule_c_line: byLine,
  auto_classified: autoClassified,
  needs_review: needsReviewCount,
  transaction_ids: ledgerAppends.map(r => r.key),
}, null, 2));
console.log('State written to data/tax_backfill_state.json');
console.log('Done.');
