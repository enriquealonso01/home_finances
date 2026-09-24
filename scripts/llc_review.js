#!/usr/bin/env node
// llc_review.js — JARVIS voice tool: query AND EDIT LLC transactions needing review/categorization.
// Commands:
//   node scripts/llc_review.js stats                        → counts summary
//   node scripts/llc_review.js list [--card X] [--limit N]  → rows needing review
//   node scripts/llc_review.js get <rowId>                  → one row's detail
//   node scripts/llc_review.js set <rowId> --scl <line> [--label <text>] --reason <why>
//   node scripts/llc_review.js set <rowId> --personal true|false --reason <why>
//   node scripts/llc_review.js set <rowId> --review <Y|N|blank> --reason <why>
// Row id format: Expenses:<sheetRow> | Revenue:<sheetRow>
// Every edit is logged to Notes and audited via console.
import { sheetsClient } from './tax_ledger.js';

const [, , cmd, ...rest] = process.argv;
const arg = (name, dflt) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : dflt;
};
const EPOCH = Date.UTC(1899, 11, 30);
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;

const SCHC = {
  '1': 'Gross receipts / sales', '2': 'Returns (contra)', '6': 'Other income',
  '8': 'Advertising', '9': 'Car & truck', '10': 'Commissions & fees', '11': 'Contract labor',
  '15': 'Insurance (other)', '16': 'Interest (mortgage)', '17': 'Legal & professional',
  '20': 'Office expense', '21': 'Pension/profit-sharing', '23': 'Rent (other)',
  '24': 'Repairs', '25': 'Utilities', '27a': 'Other costs', '28': 'Wages',
};

async function load(tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: LLC, range: `${tab}!A2:K`, valueRenderOption: 'UNFORMATTED_VALUE' });
  return (res.data.values || []).map((r, i) => ({
    tab, row: i + 2,
    date: typeof r[0] === 'number' ? new Date(EPOCH + r[0] * 86400000).toISOString().slice(0, 10) : String(r[0] ?? ''),
    desc: String(r[1] ?? ''), amount: typeof r[2] === 'number' ? r[2] : parseFloat(String(r[2]).replace(/[$,]/g, '')) || 0,
    scline: String(r[3] ?? ''), sclabel: String(r[4] ?? ''), source: String(r[5] ?? ''), card: String(r[6] ?? ''),
    review: String(r[7] ?? ''), notes: String(r[8] ?? ''), id: String(r[9] ?? ''), personal: String(r[10] ?? '').toUpperCase() === 'TRUE',
  })).filter(r => r.date && r.desc);
}

function printRow(r) { console.log(JSON.stringify(r, null, 1)); }

if (cmd === 'stats' || !cmd) {
  const expenses = await load('Expenses');
  const revenue = await load('Revenue');
  const needReview = [...expenses, ...revenue].filter(r => r.review === 'Y');
  const uncategorized = expenses.filter(r => !r.scline && r.review !== 'Y' && !r.personal);
  const byCard = {};
  needReview.forEach(r => byCard[r.card || r.source] = (byCard[r.card || r.source] || 0) + 1);
  console.log(JSON.stringify({
    needing_review: needReview.length,
    needing_review_dollars: Math.round(needReview.reduce((a, r) => a + r.amount, 0) * 100) / 100,
    by_card: byCard,
    uncategorized_no_schc_line: uncategorized.length,
    uncategorized_dollars: Math.round(uncategorized.reduce((a, r) => a + r.amount, 0) * 100) / 100,
    personal_flagged: expenses.filter(r => r.personal).length,
    total_rows: expenses.length + revenue.length,
  }, null, 1));
} else if (cmd === 'list') {
  const card = arg('--card');
  const limit = parseInt(arg('--limit', '40'));
  const expenses = await load('Expenses');
  const revenue = await load('Revenue');
  const needReview = [...expenses, ...revenue].filter(r => r.review === 'Y');
  const uncategorized = expenses.filter(r => !r.scline && r.review !== 'Y' && !r.personal);
  let rows = [...needReview.map(r => ({ ...r, kind: 'review' })), ...uncategorized.map(r => ({ ...r, kind: 'uncategorized' }))];
  if (card) rows = rows.filter(r => (r.card || r.source).toLowerCase().includes(card.toLowerCase()));
  rows.slice(0, limit).forEach(r => console.log(`${r.tab}:${r.row} | ${r.date} | $${r.amount.toFixed(2)} | ${r.desc.slice(0, 42)} | ${r.card || r.source} | ${r.kind}${r.personal ? ' | PERSONAL' : ''}`));
  console.log(`-- ${Math.min(rows.length, limit)} of ${rows.length} rows`);
} else if (cmd === 'get') {
  const [tab, rowStr] = (rest[0] || '').split(':');
  const pool = await load(tab === 'Revenue' ? 'Revenue' : 'Expenses');
  const r = pool.find(x => x.row === parseInt(rowStr));
  printRow(r || `row not found: ${rest[0]}`);
} else if (cmd === 'set') {
  const rowId = rest[0] || '';
  const [tab, rowStr] = rowId.split(':');
  if (!['Expenses', 'Revenue'].includes(tab) || !parseInt(rowStr)) {
    console.log(JSON.stringify({ success: false, error: "rowId must be 'Expenses:<n>' or 'Revenue:<n>'" }));
    process.exit(1);
  }
  const reason = arg('--reason', '');
  if (!reason) { console.log(JSON.stringify({ success: false, error: '--reason required (audit trail)' })); process.exit(1); }
  const pool = await load(tab);
  const r = pool.find(x => x.row === parseInt(rowStr));
  if (!r) { console.log(JSON.stringify({ success: false, error: `row not found: ${rowId}` })); process.exit(1); }

  const updates = {};   // header -> new value
  const stamp = `[${new Date().toISOString().slice(0, 16)}Z jarvis]`;

  const scl = arg('--scl');
  if (scl !== undefined) {
    const key = scl.trim();
    const label = SCHC[key.replace(/\.0$/, '')] || (key === 'P1' ? 'Gross receipts / sales (contra)' : null);
    if (!label && !arg('--label')) {
      console.log(JSON.stringify({ success: false, error: `unknown Schedule C line '${scl}'. Known: ${Object.keys(SCHC).join(', ')}, P1 — or pass --label` }));
      process.exit(1);
    }
    updates.scline = String(parseFloat(key));
    updates.sclabel = arg('--label', label);
  }
  const personal = arg('--personal');
  if (personal !== undefined) {
    if (!/^(true|false)$/i.test(personal)) { console.log(JSON.stringify({ success: false, error: '--personal must be true|false' })); process.exit(1); }
    updates.personal = /true/i.test(personal);
  }
  const review = arg('--review');
  if (review !== undefined) {
    if (!/^(y|n|)$/i.test(review)) { console.log(JSON.stringify({ success: false, error: '--review must be Y, N, or blank' })); process.exit(1); }
    updates.review = review.toUpperCase();
  }
  if (!Object.keys(updates).length) { console.log(JSON.stringify({ success: false, error: 'nothing to set (use --scl, --personal, --review)' })); process.exit(1); }

  // Column map (A..K): D=scline E=sclabel H=review J=id K=personal
  const colFor = { scline: 'D', sclabel: 'E', review: 'H', personal: 'K' };
  const data = [];
  for (const [k, v] of Object.entries(updates)) data.push({ range: `${tab}!${colFor[k]}${r.row}`, values: [[v]] });
  // Notes append (col I): audit trail
  const changes = Object.entries(updates).map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v || '(blank)'}`).join('; ');
  const newNotes = `${r.notes ? r.notes + ' | ' : ''}${stamp} ${changes} — ${reason}`.slice(0, 900);
  data.push({ range: `${tab}!I${r.row}`, values: [[newNotes]] });

  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: LLC, resource: { valueInputOption: 'USER_ENTERED', data } });
  console.log(JSON.stringify({ success: true, row: rowId, desc: r.desc.slice(0, 40), changes, note_logged: true }));
} else {
  console.log('usage: stats | list [--card X] [--limit N] | get <Tab:row> | set <Tab:row> --scl <line> [--label T] --reason R | set <Tab:row> --personal true|false --reason R | set <Tab:row> --review Y|N --reason R');
}
