import { sheetsClient } from '/root/projects/home_finances/scripts/tax_ledger.js';
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
// Move the legacy-2025 revenue block INTO the Revenue tab, so nothing ever reads the
// deprecated tab again — not even build_expenses_revenue's legacy block.
const meta = await sheets.spreadsheets.get({ spreadsheetId: LLC });
const llcTab = meta.data.sheets.find(s => /LLC Transactions/.test(s.properties.title));
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: LLC, range: `${llcTab.properties.title}!O4:Q23`, valueRenderOption: 'UNFORMATTED_VALUE',
});
const apply = process.argv.includes('--apply');
const rows = (res.data.values || []);
// fetch existing revenue ids
const rev = await sheets.spreadsheets.values.get({ spreadsheetId: LLC, range: 'Revenue!A2:K', valueRenderOption: 'UNFORMATTED_VALUE' });
const existing = new Set((rev.data.values || []).map(r => String(r[9] ?? '')));
const EPOCH = Date.UTC(1899, 11, 30);
const out = [];
rows.forEach((r, i) => {
  const sheetRow = 4 + i;
  const refId = `legacy-rev:${sheetRow}`;
  if (existing.has(refId)) return; // already in Revenue tab
  if (!String(r[2] ?? '').trim()) return;
  if (typeof r[0] !== 'number') return;
  const date = new Date(EPOCH + r[0] * 86400000).toISOString().slice(0, 10);
  const amount = typeof r[1] === 'number' ? r[1] : parseFloat(String(r[1]).replace(/[$,]/g, '')) || 0;
  const desc = String(r[2] ?? '').trim();
  const isTF = /ticketflipping/i.test(desc), isReimb = /reimbursement/i.test(desc), isFB = /facebook/i.test(desc);
  out.push([date,
    isTF ? 'Ticketflipping payout' : isFB ? 'Facebook payout' : desc,
    amount,
    isReimb ? '6' : '1',
    isReimb ? 'Other income' : 'Gross receipts / sales',
    isTF ? 'Ticketflipping' : isFB ? 'Facebook' : 'Manual-2025sheet',
    '', '', `legacy 2025 sheet manual row ${sheetRow}`, refId, '']);
  console.log('to move:', date, amount, desc.slice(0, 30));
});
console.log('rows to copy into Revenue:', out.length);
if (!apply) { console.log('dry run only'); process.exit(0); }
if (out.length) await sheets.spreadsheets.values.append({ spreadsheetId: LLC, range: 'Revenue!A1', valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: out } });
console.log('APPLIED');
