import { sheetsClient, pullPlaidTransactions } from '/root/projects/home_finances/scripts/tax_ledger.js';
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const EPOCH = Date.UTC(1899, 11, 30);
const apply = process.argv.includes('--apply');
// Pull the 4 real Tello credits from Plaid and stamp the manual rows with true dates + Plaid IDs.
const txns = await pullPlaidTransactions('2026-07-10', '2026-07-25');
const credits = txns.filter(t => /tello/i.test(t.name || '') && Number(t.amount) > 0)
  .map(t => ({ date: t.date || t.iso_date, id: t.transaction_id, amt: Number(t.amount) }))
  .sort((a, b) => a.date < b.date ? -1 : 1);
console.log('bank credits:', credits.map(c => `${c.date} ${c.id.slice(0, 10)}`).join(' | '));
const res = await sheets.spreadsheets.values.get({ spreadsheetId: LLC, range: 'Revenue!A2:K', valueRenderOption: 'UNFORMATTED_VALUE' });
const targets = [];
(res.data.values || []).forEach((r, i) => {
  const id = String(r[9] ?? '');
  if (/tello/i.test(String(r[1] ?? '')) && (id.startsWith('manual:r-') || id.startsWith('manual:'))) {
    targets.push({ row: i + 2, oldId: id });
  }
});
console.log('manual Tello rows:', targets.length);
if (targets.length !== credits.length) { console.log('COUNT MISMATCH — aborting'); process.exit(1); }
if (!apply) { console.log('dry run'); process.exit(0); }
targets.sort((a, b) => a.row - b.row);
for (let i = 0; i < targets.length; i++) {
  const c = credits[i];
  await sheets.spreadsheets.values.update({
    spreadsheetId: LLC, range: `Revenue!A${targets[i].row}:C${targets[i].row}`, valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[c.date, 'TELLO MOBILE - refund/credit', c.amt]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: LLC, range: `Revenue!J${targets[i].row}`, valueInputOption: 'RAW',
    requestBody: { values: [[`plaid:${c.id}`]] },
  });
  console.log(`r${targets[i].row} → ${c.date} plaid:${c.id.slice(0, 12)}`);
}
console.log('APPLIED');
