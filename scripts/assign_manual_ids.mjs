import { sheetsClient } from '/root/projects/home_finances/scripts/tax_ledger.js';
import fs from 'node:fs';
const apply = process.argv.includes('--apply');
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;

// Assign stable Ref/IDs to Manual rows lacking them. Key = date+amount+desc slug.
// These act as the idempotency keys going forward (replaces ledger col AB).
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
const changes = [];
for (const tab of ['Expenses', 'Revenue']) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: LLC, range: `${tab}!A2:J`, valueRenderOption: 'UNFORMATTED_VALUE' });
  (res.data.values || []).forEach((r, i) => {
    if (r[9]) return;
    const id = `manual:${tab === 'Expenses' ? 'e' : 'r'}-${r[0]}-${slug(r[1])}`;
    changes.push({ range: `${tab}!J${i + 2}`, values: [[id]] });
    console.log(tab, i + 2, '→', id);
  });
}
if (!apply) { console.log(`\n${changes.length} IDs to assign. Re-run with --apply.`); process.exit(0); }
for (let i = 0; i < changes.length; i += 400) {
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: LLC, valueInputOption: 'RAW', requestBody: { data: changes.slice(i, i + 400) } });
}
console.log(`APPLIED: ${changes.length} manual Ref/IDs written.`);
