import { sheetsClient } from '/root/projects/home_finances/scripts/tax_ledger.js';
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const EPOCH = Date.UTC(1899, 11, 30);
const apply = process.argv.includes('--apply');

// Read the FULL Revenue tab, keep header + deduped real rows, drop empties/junk.
const res = await sheets.spreadsheets.values.get({ spreadsheetId: LLC, range: 'Revenue!A2:K', valueRenderOption: 'UNFORMATTED_VALUE' });
const rows = (res.data.values || []).filter(r => r.some(c => c !== '' && c != null));
console.log('non-empty rows:', rows.length);

const seen = new Set();
const kept = [];
let dropped = 0;
for (const r of rows) {
  const id = String(r[9] ?? '');
  const date = typeof r[0] === 'string' ? r[0] : (typeof r[0] === 'number' ? new Date(EPOCH + r[0] * 86400000).toISOString().slice(0, 10) : '');
  const amount = typeof r[2] === 'number' ? r[2] : parseFloat(String(r[2]).replace(/[$,]/g, '')) || 0;
  const desc = String(r[1] ?? '');
  if (!date || !desc) { dropped++; continue; }
  // prefer rows WITH Sch C line when dupe id
  if (id && seen.has(id)) {
    // drop the already-kept copy if this one is richer? simpler: drop later copy
    dropped++;
    console.log('dup dropped:', id, date, amount);
    continue;
  }
  if (id) seen.add(id);
  kept.push([date, desc, amount, String(r[3] ?? ''), String(r[4] ?? ''), String(r[5] ?? ''),
    String(r[6] ?? ''), String(r[7] ?? ''), String(r[8] ?? ''), id, String(r[10] ?? '')]);
}
console.log('kept:', kept.length, '| dropped:', dropped);
// dup id analysis
const ids = kept.map(r => r[9]).filter(Boolean);
const dups = ids.filter((x, i) => ids.indexOf(x) !== i);
console.log('remaining dup ids:', [...new Set(dups)]);
if (!apply) { console.log('dry run'); process.exit(0); }
await sheets.spreadsheets.values.clear({ spreadsheetId: LLC, range: 'Revenue!A2:K5000' });
await sheets.spreadsheets.values.update({ spreadsheetId: LLC, range: 'Revenue!A2', valueInputOption: 'RAW', requestBody: { values: kept } });
console.log('APPLIED — Revenue tab compacted to', kept.length, 'rows');
