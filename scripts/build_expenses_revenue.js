#!/usr/bin/env node
// build_expenses_revenue.js — v3 (2026-09-21, per Enrique: LLC Transactions is
// DEPRECATED — this script no longer reads it, ever).
//
// Source of truth = Expenses + Revenue tabs themselves. Flow:
//   1. READ current Expenses + Revenue tabs (incl. Ref/ID idempotency keys).
//   2. MERGE in new rows passed by ingestors (shopify_payouts v2 writes here too;
//      ingest_statement_rows appends directly). Merge is idempotent on Ref/ID.
//   3. NORMALIZE: dedup Manual-vs-pipeline, TF→Revenue routing, revenue source
//      names, refunds positive, Personal flags.
//   4. WRITE back Expenses + Revenue + Summary (Sch C format).
//
//   node scripts/build_expenses_revenue.js [--apply]
//
// Optional legacy merge (one-time, already applied): --merge-legacy reads the
// deprecated tab ONCE to port stamped 2026 rows that predate this design.
import fs from 'node:fs';
import path from 'node:path';
import { sheetsClient } from './tax_ledger.js';

const apply = process.argv.includes('--apply');
const mergeLegacy = process.argv.includes('--merge-legacy');
const LLC = process.env.LLC_SHEET_ID;
const accounts = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config/accounts.json'), 'utf-8')).accounts;
const EPOCH = Date.UTC(1899, 11, 30);

const HEADERS = ['Date', 'Description', 'Amount', 'Sch C Line', 'Sch C Label',
  'Source', 'Card', 'Review', 'Notes', 'Ref/ID', 'Personal'];

// ---- vendor alias table for dedup -------------------------------------------
const ALIASES = [
  [/(?:at&t)/i, /att/i], [/amazon web services/i, /^aws/i], [/amazon prime video/i, /prime video/i],
  [/google cloud/i, /^cloud/i], [/facebook/i, /^facebk/i], [/florida power|fpl -/i, /fpl/i],
  [/chase - monthly|monthly service/i, /monthly service/i], [/hyatt/i, /hyatt/i],
  [/llc annual report/i, /division of corp|nic\*-dos/i], [/mississipp/i, /mississippi/i],
  [/(tst|cp|sq)\*\s*/i, /(?:tst|cp|sq)\*\s*/i],
];
const vend = s => String(s).toLowerCase().replace(/^orig co name:?\s*/i, '').replace(/^(tst|cp|sq|pos|paypal)\*\s*/i, '').replace(/[^a-z0-9]/g, '').slice(0, 8);
const aliasMatch = (a, b) => ALIASES.some(([x, y]) => x.test(a) && y.test(b)) || vend(a) === vend(b)
  || vend(b).includes(vend(a)) || vend(a).includes(vend(b));

function sourceOf(id, card) {
  const s = String(id || '');
  if (s.startsWith('shopify-payout') || s.startsWith('shopify-fee')) return 'Shopify';
  if (!s) return 'Manual';
  const c = String(card || '');
  if (/shopify/i.test(c)) return 'Shopify';
  if (/citi/i.test(c)) return 'Citi';
  if (/P&S|chase/i.test(c)) return 'Chase';
  const acct = accounts.find(a => s.startsWith(a.account_id.slice(0, 8)));
  if (!acct) return 'Manual';
  if (/chase/i.test(acct.institution)) return 'Chase';
  if (/citi/i.test(acct.institution)) return 'Citi';
  return acct.institution;
}

const sheets = await sheetsClient();

// ---- 1. READ current tabs (source of truth) ----------------------------------
async function readTab(tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: LLC, range: `${tab}!A2:K`, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (res.data.values || []).filter(r => r[0] || r[1]).map(r => ({
    date: typeof r[0] === 'string' ? r[0] : new Date(EPOCH + Number(r[0]) * 86400000).toISOString().slice(0, 10),
    desc: String(r[1] ?? ''),
    amount: typeof r[2] === 'number' ? r[2] : parseFloat(String(r[2]).replace(/[$,]/g, '')) || 0,
    scline: String(r[3] ?? ''),
    sclabel: String(r[4] ?? ''),
    source: String(r[5] ?? '') || sourceOf(r[9], r[6]),
    card: String(r[6] ?? ''),
    review: String(r[7] ?? '') === 'Y' ? 'Y' : '',
    notes: String(r[8] ?? ''),
    id: String(r[9] ?? ''),
    personal: String(r[10] ?? '').toUpperCase() === 'TRUE',
  }));
}

let expenses = await readTab('Expenses');
let revenue = await readTab('Revenue');

// ---- optional one-time legacy merge (deprecated tab) --------------------------
if (mergeLegacy) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: LLC });
  const llcTab = meta.data.sheets.find(s => /LLC Transactions/.test(s.properties.title));
  if (!llcTab) { console.error('Legacy tab not found'); process.exit(1); }
  const LAST = llcTab.properties.gridProperties.rowCount;
  const grid = await sheets.spreadsheets.values.get({
    spreadsheetId: LLC, range: `${llcTab.properties.title}!A1:AB${LAST}`, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = grid.data.values || [];
  const seen = new Set([...expenses, ...revenue].map(x => x.id).filter(Boolean));
  let added = 0, skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const type = String(r[20] ?? '').trim();
    if (!type) continue;
    const serial = r[1];
    if (typeof serial !== 'number') { skipped++; continue; }
    const dt = new Date(EPOCH + serial * 86400000);
    if (dt.getUTCFullYear() !== 2026) { skipped++; continue; }
    const id = String(r[27] ?? '');
    if (id && seen.has(id)) { skipped++; continue; }
    if (id) seen.add(id);
    const amount = typeof r[2] === 'number' ? r[2] : parseFloat(String(r[2]).replace(/[$,]/g, '')) || 0;
    const notes = String(r[26] ?? '');
    const desc = String(r[3] ?? '');
    const src = sourceOf(id, String(r[5] ?? ''));
    const isTF = /zelle payment from.*ticket flipping/i.test(desc) || src === 'Ticketflipping';
    const row = {
      date: dt.toISOString().slice(0, 10), desc, amount,
      scline: String(r[21] ?? ''), sclabel: String(r[22] ?? ''),
      source: src, card: String(r[5] ?? ''),
      review: String(r[25] ?? '') === 'Y' ? 'Y' : '',
      notes, id, personal: /^personal$/i.test(String(r[23] ?? '').trim()),
    };
    const isRevNote = /revenue not expense/i.test(notes);
    if (isTF || (isRevNote && amount > 0) || type === 'Income' || type === 'Refund') {
      if (type === 'Refund') { row.amount = Math.abs(row.amount); row.scline = row.scline || '1'; row.sclabel = row.sclabel || 'Gross receipts / sales'; row.notes = (row.notes ? row.notes + '; ' : '') + 'refund received (positive)'; }
      revenue.push(row);
    } else if (type === 'Expense' || type === 'COGS') {
      expenses.push(row);
    } else { skipped++; }
    added++;
  }
  console.log(`Legacy merge: added=${added} skipped=${skipped}`);
}

// ---- legacy 2025-sheet revenue block ------------------------------------------
// MIGRATED 2026-09-21: all legacy-rev:* rows now live in the Revenue tab itself
// (scripts/migrate_legacy_rev.mjs). No deprecated-tab reads remain anywhere.
const legacyAddedCount = 0;

// ---- bank-verified TF Zelle credits ---------------------------------------------
// REMOVED 2026-09-21: those two rows already live in Revenue with their real Plaid
// bank IDs. Static re-seeding caused exact TF payout duplicates ($75k phantom income).

// ---- 3. normalize ---------------------------------------------------------------
// 3a. revenue source names + descriptions
for (const r of revenue) {
  if (/ticket\s?flipping/i.test(r.desc) || r.source === 'Ticketflipping') { r.source = 'Ticketflipping'; if (!/^Ticketflipping payout/.test(r.desc)) r.desc = 'Ticketflipping payout'; }
  else if (r.source === 'Shopify') { if (!/^Shopify payout/.test(r.desc)) r.desc = 'Shopify payout (Krendora)'; }
  else if (/facebook/i.test(r.desc)) { r.source = 'Facebook'; r.desc = 'Facebook payout'; }
  else if (/krendora/i.test(r.desc)) { r.source = 'Shopify'; r.desc = 'Shopify payout (Krendora)'; }
}
// 3b. refunds always positive
for (const r of revenue) {
  if (Number(r.amount) < 0) { r.amount = Math.abs(r.amount); r.notes = (r.notes ? r.notes + '; ' : '') + 'refund received (positive)'; }
}
// 3c. TF incoming rows mis-filed as expenses → revenue
{
  const moved = [];
  expenses = expenses.filter(x => {
    const isTF = /zelle payment from.*ticket flipping/i.test(x.desc) || x.source === 'Ticketflipping';
    if (isTF) { moved.push(x); return false; }
    return true;
  });
  revenue.push(...moved);
}
// 3d. DEDUP: drop Manual expense rows duplicating a pipeline row (annotation carries over)
{
  const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
  const pipeExp = expenses.filter(x => x.source !== 'Manual');
  const drops = new Set();
  for (const m of expenses.filter(x => x.source === 'Manual')) {
    for (const p of pipeExp) {
      if (Number(p.amount) === Number(m.amount) && dayDiff(m.date, p.date) <= 2 && aliasMatch(m.desc, p.desc)) {
        drops.add(m);
        if (m.personal) { p.personal = true; p.review = 'Y'; }
        if (/revenue not expense/i.test(m.notes)) { p.notes = (p.notes ? p.notes + '; ' : '') + 'REVENUE NOT EXPENSE'; p.review = 'Y'; }
        if (m.review === 'Y' && !p.review) p.review = 'Y';
        break;
      }
    }
  }
  expenses = expenses.filter(x => !drops.has(x));
  var manualDrops = drops.size;
}

// ---- sort, stats ------------------------------------------------------------------
const byDate = (a, b) => a.date.localeCompare(b.date) || a.desc.localeCompare(b.desc);
expenses.sort(byDate); revenue.sort(byDate);

const meta = await sheets.spreadsheets.get({ spreadsheetId: LLC });
const tabOf = (name) => meta.data.sheets.find(s => s.properties.title === name);
const expTab = tabOf('Expenses'), revTab = tabOf('Revenue');

const toValues = list => list.map(x => [x.date, x.desc, x.amount, x.scline, x.sclabel,
  x.source, x.card, x.review, x.notes, x.id, x.personal ? 'TRUE' : '']);

console.log(`Expenses: ${expenses.length} (dropped ${manualDrops} manual dups) | Revenue: ${revenue.length}`);
console.log('Expenses by source:', JSON.stringify(expenses.reduce((a, x) => { a[x.source] = (a[x.source] || 0) + 1; return a; }, {})));
console.log('Revenue by source:', JSON.stringify(revenue.reduce((a, x) => { a[x.source] = (a[x.source] || 0) + 1; return a; }, {})));
console.log(`Legacy revenue block: added=${legacyAddedCount || 0} | Bank TF Zelle reseed: removed (was duping rows)`);
console.log(`Personal=TRUE: ${expenses.filter(x => x.personal).length} | Review=Y: ${expenses.filter(x => x.review === 'Y').length}`);
console.log(`Revenue negative rows (should be 0): ${revenue.filter(x => Number(x.amount) < 0).length}`);

// ---- Summary computation (Sch C format, personal-excluded) ------------------------
const active = expenses.filter(x => !x.personal);
const schC = new Map();
for (const x of active) {
  const line = String(x.scline || '').trim() || '??';
  const label = String(x.sclabel || '').trim() || 'Uncategorized';
  const k = `${line}|${label}`;
  schC.set(k, (schC.get(k) || 0) + Number(x.amount));
}
const cogsTotal = [...schC].filter(([k]) => k.startsWith('P3')).reduce((a, [, v]) => a + v, 0);
const partV = [...schC].filter(([k]) => k.startsWith('27a'));
const partVTotal = partV.reduce((a, [, v]) => a + v, 0);
const otherLines = [...schC].filter(([k]) => !k.startsWith('P3') && !k.startsWith('27a') && k !== '??');
const reviewRows = active.filter(x => x.review === 'Y' || !String(x.scline || '').trim());
const income = revenue.reduce((a, x) => a + Number(x.amount), 0);
const expTotal = active.reduce((a, x) => a + Number(x.amount), 0);

const summaryRows = [];
summaryRows.push(['', '', '', '', '', '', '', '', '', '', '', '', '']);
summaryRows.push(['', '2026 Proven & Solved LLC — Schedule C Summary', '', '', '', '', '', '', '', '', '', '', '']);
summaryRows.push(['', `Generated ${new Date().toISOString().slice(0, 10)} · excludes Personal=TRUE rows · Revenue shows refunds as positive`, '']);
summaryRows.push(['']);
summaryRows.push(['', '', '', 'Amount']);
summaryRows.push(['', 'Revenue (Part I)', '', '']);
summaryRows.push(['', '  Ticketflipping', '', revenue.filter(x => x.source === 'Ticketflipping').reduce((a, x) => a + Number(x.amount), 0)]);
summaryRows.push(['', '  Shopify (Krendora)', '', revenue.filter(x => x.source === 'Shopify').reduce((a, x) => a + Number(x.amount), 0)]);
summaryRows.push(['', '  Facebook', '', revenue.filter(x => x.source === 'Facebook').reduce((a, x) => a + Number(x.amount), 0)]);
summaryRows.push(['', '  Other income', '', revenue.filter(x => !['Ticketflipping', 'Shopify', 'Facebook'].includes(x.source)).reduce((a, x) => a + Number(x.amount), 0)]);
summaryRows.push(['', 'Total income', '', income]);
summaryRows.push(['']);
summaryRows.push(['', 'Cost of Goods Sold (Part II, line 4)', '', cogsTotal]);
summaryRows.push(['']);
summaryRows.push(['', 'Expenses (Part II) by Sch C line', '', '']);
for (const [k, v] of otherLines.sort((a, b) => a[0].localeCompare(b[0]))) {
  const [line, label] = k.split('|');
  summaryRows.push(['', `  Line ${line} — ${label}`, '', v]);
}
summaryRows.push(['', '  Line 27a — Other expenses (Part V breakdown below)', '', partVTotal]);
for (const [k, v] of partV.sort((a, b) => b[1] - a[1])) {
  const [, label] = k.split('|');
  summaryRows.push(['', `    · ${label}`, '', v]);
}
summaryRows.push(['', 'Total expenses', '', expTotal]);
summaryRows.push(['']);
summaryRows.push(['', 'NET PROFIT (loss)', '', income - cogsTotal - expTotal]);
summaryRows.push(['']);
summaryRows.push(['', `Rows flagged Review=Y (you decide business vs personal): ${reviewRows.length}`]);
summaryRows.push(['', `Rows with Personal=TRUE (excluded): ${expenses.length - active.length}`]);

console.log(`Summary: income=${income} cogs=${cogsTotal} exp=${expTotal} net=${income - cogsTotal - expTotal}`);

if (!apply) { console.log('DRY RUN — re-run with --apply to write.'); process.exit(0); }

for (const [tab, list] of [['Expenses', expenses], ['Revenue', revenue]]) {
  await sheets.spreadsheets.values.clear({ spreadsheetId: LLC, range: `${tab}!A1:Z1000` });
  const values = [HEADERS, ...toValues(list)];
  await sheets.spreadsheets.values.update({
    spreadsheetId: LLC, range: `${tab}!A1`, valueInputOption: 'RAW',
    requestBody: { values },
  });
}
await sheets.spreadsheets.values.clear({ spreadsheetId: LLC, range: 'Summary!A1:M45' });
await sheets.spreadsheets.values.update({
  spreadsheetId: LLC, range: 'Summary!A1', valueInputOption: 'USER_ENTERED',
  requestBody: { values: summaryRows },
});
const boolReq = {
  setDataValidation: {
    range: { sheetId: expTab.properties.sheetId, startRowIndex: 1, endRowIndex: expenses.length + 1, startColumnIndex: 10, endColumnIndex: 11 },
    rule: { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true },
  },
};
await sheets.spreadsheets.batchUpdate({
  spreadsheetId: LLC,
  requestBody: { requests: [expTab, revTab].map(t => ({
    repeatCell: { range: { sheetId: t.properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' },
  })).concat([expTab, revTab].map(t => ({
    updateSheetProperties: { properties: { sheetId: t.properties.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' },
  }))).concat([boolReq]) },
});
console.log('APPLIED: Expenses + Revenue + Summary rebuilt (no deprecated-tab reads).');
