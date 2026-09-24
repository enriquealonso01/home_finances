import { sheetsClient } from '/root/projects/home_finances/scripts/tax_ledger.js';
const apply = process.argv.includes('--apply');
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const fix = [];
for (const tab of ['Expenses', 'Revenue']) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: LLC, range: `${tab}!A2:J`, valueRenderOption: 'UNFORMATTED_VALUE' });
  const seen = new Map();
  (res.data.values || []).forEach((r, i) => {
    const id = r[9];
    if (!id) return;
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    if (n > 1) fix.push({ range: `${tab}!J${i + 2}`, values: [[`${id}-${n}`]] });
  });
}
fix.forEach(f => console.log(f.range, '→', f.values[0][0]));
if (!apply) { console.log(`${fix.length} duplicate IDs to disambiguate. Re-run with --apply.`); process.exit(0); }
if (fix.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: LLC, valueInputOption: 'RAW', requestBody: { data: fix } });
console.log(`APPLIED: ${fix.length} IDs disambiguated.`);
