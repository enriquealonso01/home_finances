import { sheetsClient } from '/root/projects/home_finances/scripts/tax_ledger.js';
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const EPOCH = Date.UTC(1899, 11, 30);
const apply = process.argv.includes('--apply');
// Purge every remaining zelle-tf: row from Revenue (their Plaid-ID twins are canonical)
const res = await sheets.spreadsheets.values.get({ spreadsheetId: LLC, range: 'Revenue!A2:K', valueRenderOption: 'UNFORMATTED_VALUE' });
const meta = await sheets.spreadsheets.get({ spreadsheetId: LLC, ranges: ['Revenue'] });
const sheetId = meta.data.sheets.find(s => s.properties.title === 'Revenue').properties.sheetId;
const hits = [];
(res.data.values || []).forEach((r, i) => {
  if (String(r[9] ?? '').startsWith('zelle-tf:')) {
    const date = typeof r[0] === 'number' ? new Date(EPOCH + r[0] * 86400000).toISOString().slice(0, 10) : String(r[0]);
    hits.push({ row: i + 2, date, amt: r[2], id: r[9] });
  }
});
hits.forEach(h => console.log('purge r' + h.row, h.date, h.amt, h.id));
console.log('zelle-tf rows to purge:', hits.length);
if (!apply) { console.log('dry run'); process.exit(0); }
hits.sort((a, b) => b.row - a.row);
for (const h of hits) {
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: LLC, requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: h.row - 1, endIndex: h.row } } }] } });
}
console.log('APPLIED — purged', hits.length);
