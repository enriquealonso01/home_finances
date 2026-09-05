// Backfill Jessica's Wells Fargo (personal checking, ...5516) into a family month tab.
//
// WF is NOT in config/accounts.json as a script-managed account on purpose: the user
// hand-curates it with their own descriptions/categories (see Apr 2026). run_month.js
// therefore skips WF as "UNMAPPED". This script adds WF rows following that convention:
//   AT&T      -> "AT&T Phone Jess" / Phone        (Jess's phone line)
//   Patientfi -> "Laser PatientFi" / Subscriptions (laser financing)
//   Netflix   -> "Netflix"         / Subscriptions
//   anything else -> Other, flagged "⚠ review"
// Excluded (per the user's Apr convention): the $500 HEICO payroll *splits* (income),
// all Zelle transfers, and credit-card payments (Chase CC / Apple Card).
//
// WF is personal => family sheet only, never LLC. Rows are appended (existing rows are
// never touched) with serial-number dates so the en_US locale can't misread them.
// Idempotent: a WF row already present (same amount + date) is skipped.
//
// Usage: node scripts/backfill_wf.js YYYY-MM [--apply]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const args = process.argv.slice(2);
const month = args.find(a => /^\d{4}-\d{2}$/.test(a));
const apply = args.includes('--apply');
if (!month) { console.error('Usage: node scripts/backfill_wf.js YYYY-MM [--apply]'); process.exit(1); }

const [year, mo] = month.split('-').map(Number);
const startDate = `${year}-${String(mo).padStart(2, '0')}-01`;
const lastDay = new Date(year, mo, 0).getDate();
const endDate = `${year}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
const monthShort = new Date(year, mo - 1, 1).toLocaleString('en-US', { month: 'short' });
const tab = `${monthShort} ${year}`;
const CARD = 'WELLS FARGO';

const KEY_FILE = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ? process.env.GOOGLE_APPLICATION_CREDENTIALS
  : path.join(ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS);

function familyDateSerial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}
function serialToDisplay(s) {
  const dt = new Date(Date.UTC(1899, 11, 30) + s * 86400000);
  return `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}/${dt.getUTCFullYear()}`;
}

// ── pull Wells Fargo transactions ────────────────────────────────────────────
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets/plaid_tokens.json'), 'utf-8'));
const wf = Object.values(tokens).find(t => /wells fargo/i.test(t.institution_name));
if (!wf) { console.error('No Wells Fargo token found'); process.exit(1); }

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
  baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET } },
}));

const txns = [];
let offset = 0;
while (true) {
  const resp = await plaid.transactionsGet({
    access_token: wf.access_token, start_date: startDate, end_date: endDate,
    options: { offset, count: 500 },
  });
  txns.push(...resp.data.transactions);
  if (resp.data.transactions.length < 500) break;
  offset += 500;
  if (offset >= resp.data.total_transactions) break;
}

function mapWf(tx) {
  const pfc = tx.personal_finance_category?.primary;
  const pfcd = tx.personal_finance_category?.detailed || '';
  const name = tx.name || '';
  const merch = tx.merchant_name || '';
  if (pfc === 'TRANSFER_IN' || pfc === 'TRANSFER_OUT') return null;            // Zelle etc.
  if (pfc === 'LOAN_PAYMENTS' && /CREDIT_CARD/.test(pfcd)) return null;         // CC payments
  if (/applecard gsbank payment|chase credit crd/i.test(name)) return null;
  if (pfc === 'INCOME') return null;                                           // HEICO $500 splits
  if (tx.amount <= 0) return null;                                             // only outflows
  const costo = Math.abs(tx.amount);
  const blob = `${name} ${merch}`;
  if (/at\s*&?\s*t|mobility/i.test(blob)) return { desc: 'AT&T Phone Jess', cat: 'Phone', costo };
  if (/patientfi/i.test(blob))            return { desc: 'Laser PatientFi', cat: 'Subscriptions', costo };
  if (/netflix/i.test(blob))              return { desc: 'Netflix', cat: 'Subscriptions', costo };
  return { desc: (merch || name).slice(0, 60), cat: 'Other', costo, review: true };
}

const candidates = [];
for (const tx of txns) {
  const m = mapWf(tx);
  if (!m) continue;
  candidates.push({ ...m, date: tx.date, serial: familyDateSerial(tx.date) });
}
candidates.sort((a, b) => a.serial - b.serial);

// ── read existing tab: last data row + existing WF rows (dedup) ───────────────
const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });
const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.FAMILY_SHEET_ID });
const sheet = meta.data.sheets.find(s => s.properties.title === tab);
if (!sheet) { console.error(`Tab "${tab}" not found`); process.exit(1); }

const existing = (await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.FAMILY_SHEET_ID, range: `${tab}!A2:G300`, valueRenderOption: 'UNFORMATTED_VALUE',
})).data.values || [];

let lastDataIdx = -1;
const wfSeen = new Set();
existing.forEach((r, i) => {
  if (r && r.slice(0, 7).some(c => c !== '' && c !== null && c !== undefined)) lastDataIdx = i;
  if (String(r[3] || '').toUpperCase() === CARD) wfSeen.add(`${Number(r[4])}|${Number(r[5])}`);
});
const firstWriteRow = 2 + lastDataIdx + 1; // 1-based sheet row after the last data row

const toWrite = candidates.filter(c => !wfSeen.has(`${c.costo}|${c.serial}`));
const skipped = candidates.length - toWrite.length;

console.log(`WF backfill ${month} → "${tab}"  apply=${apply}`);
console.log(`Pulled ${txns.length} WF txns; ${candidates.length} kept after convention filter; ${skipped} already present.`);
console.log(`Existing data ends at sheet row ${2 + lastDataIdx}; appending at row ${firstWriteRow}.\n`);
for (const c of toWrite) {
  console.log(`  ${serialToDisplay(c.serial).padStart(10)} $${c.costo.toFixed(2).padStart(8)}  ${CARD}  ${c.cat.padEnd(14)} ${c.desc}${c.review ? '   ⚠ review' : ''}`);
}
if (toWrite.length === 0) { console.log('\nNothing to add.'); process.exit(0); }
if (!apply) { console.log('\nDRY RUN. Re-run with --apply to write.'); process.exit(0); }

// ── write rows (serial dates + currency format) ──────────────────────────────
function cell(val, idx) {
  if (idx === 4) return { userEnteredValue: { numberValue: val }, userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } };
  if (idx === 5) return { userEnteredValue: { numberValue: val }, userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'd/M/yyyy' } } };
  return { userEnteredValue: { stringValue: String(val ?? '') } };
}
const rows = toWrite.map(c => ({
  values: [c.desc, c.cat, 'Expense', CARD, c.costo, c.serial, c.review ? '⚠ review' : ''].map(cell),
}));

await sheets.spreadsheets.batchUpdate({
  spreadsheetId: process.env.FAMILY_SHEET_ID,
  requestBody: { requests: [{
    updateCells: {
      range: { sheetId: sheet.properties.sheetId, startRowIndex: firstWriteRow - 1, endRowIndex: firstWriteRow - 1 + rows.length, startColumnIndex: 0, endColumnIndex: 7 },
      rows, fields: 'userEnteredValue,userEnteredFormat.numberFormat',
    },
  }] },
});
console.log(`\nWrote ${rows.length} WF row(s) to "${tab}" rows ${firstWriteRow}-${firstWriteRow + rows.length - 1}.`);
