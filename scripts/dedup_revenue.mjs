import { sheetsClient } from '/root/projects/home_finances/scripts/tax_ledger.js';
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const EPOCH = Date.UTC(1899, 11, 30);
const apply = process.argv.includes('--apply');

// 1) Tello evidence: what does the BANK ledger say about 2026-07-17 $9.41 credits?
const { pullPlaidTransactions } = await import('/root/projects/home_finances/scripts/tax_ledger.js');
const txns = await pullPlaidTransactions('2026-07-10', '2026-07-25').catch(e => { console.log('plaid pull failed:', e.message); return []; });
const tello = txns.filter(t => /tello/i.test(t.name || '') || /tello/i.test(t.merchant_name || ''));
console.log('bank Tello txns 7/10–7/25:', tello.length);
tello.forEach(t => console.log(' ', (t.date || t.iso_date), t.amount, (t.name || '').slice(0, 40), t.transaction_id?.slice(0, 12)));

// 2) Revenue-side deletion: drop manual/legacy copy when a bank/pipeline twin exists.
const res = await sheets.spreadsheets.values.get({ spreadsheetId: LLC, range: 'Revenue!A2:K', valueRenderOption: 'UNFORMATTED_VALUE' });
const rows = (res.data.values || []).map((r, i) => ({
  row: i + 2,
  date: typeof r[0] === 'number' ? new Date(EPOCH + r[0] * 86400000).toISOString().slice(0, 10) : String(r[0] ?? ''),
  desc: String(r[1] ?? ''), amount: typeof r[2] === 'number' ? r[2] : parseFloat(String(r[2]).replace(/[$,]/g, '')) || 0,
  notes: String(r[8] ?? ''), id: String(r[9] ?? ''),
})).filter(r => r.date && r.desc);

const isPipeline = id => /^(plaid:|shopify-payout:|shopify-fee:)/.test(id) || /^[A-Za-z0-9]{20,}$/.test(id); // raw plaid tx ids
const toDelete = [];
for (const a of rows) {
  if (isPipeline(a.id)) continue; // bank/pipeline rows are canonical, never delete
  const twin = rows.find(b => b !== a && isPipeline(b.id) && b.date === a.date && Math.abs(b.amount - a.amount) < 0.005);
  if (!twin) continue;
  if (a.notes && !/legacy 2025 sheet/.test(a.notes)) {
    console.log('KEEP-CHECK: manual row has notes — copy to twin?', a.date, a.amount, JSON.stringify(a.notes.slice(0, 60)));
  }
  toDelete.push({ ...a, twin: twin.id.slice(0, 20) });
}
let sum = 0;
toDelete.forEach(d => { sum += d.amount; console.log(`DELETE r${d.row} ${d.date} $${d.amount.toFixed(2)} id=${d.id.slice(0, 26)} (twin ${d.twin})`); });
console.log('to delete:', toDelete.length, 'rows | total $' + sum.toFixed(2));
if (!apply) { console.log('dry run'); process.exit(0); }
// delete bottom-up by row index (fetch sheetId once)
const meta = await sheets.spreadsheets.get({ spreadsheetId: LLC, ranges: ['Revenue'] });
const revSheetId = meta.data.sheets.find(s => s.properties.title === 'Revenue').properties.sheetId;
toDelete.sort((x, y) => y.row - x.row);
for (const d of toDelete) {
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: LLC, requestBody: { requests: [{ deleteDimension: { range: { sheetId: revSheetId, dimension: 'ROWS', startIndex: d.row - 1, endIndex: d.row } } }] } });
}
console.log('APPLIED — deleted', toDelete.length, 'duplicate rows');
