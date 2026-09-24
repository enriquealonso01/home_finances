#!/usr/bin/env node
// fix_stamp_offset.mjs — one-time: shift tax stamps T..Z → U..AA for stmt-backfill rows.
import { sheetsClient } from './tax_ledger.js';
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const meta = await sheets.spreadsheets.get({ spreadsheetId: LLC });
const tab = meta.data.sheets.find(s => s.properties.title === 'LLC Transactions');
const LAST = tab.properties.gridProperties.rowCount;
const grid = await sheets.spreadsheets.values.get({
  spreadsheetId: LLC, range: `LLC Transactions!A1:AB${LAST}`, valueRenderOption: 'UNFORMATTED_VALUE',
});
const updates = [];
(grid.data.values || []).forEach((r, i) => {
  const rowN = i + 1;
  const id = String(r[27] ?? '');
  if (!id.startsWith('stmt-')) return;
  const type = r[19], scline = r[20], tt = r[21], bu = r[22], pct = r[23], rev = r[24], notes = r[25];
  if (!type) return; // already fixed
  updates.push({
    range: `LLC Transactions!T${rowN}:AA${rowN}`,
    values: [['', type, scline, tt, bu, pct, rev, notes]],
  });
});
console.log('rows to fix:', updates.length);
if (process.argv.includes('--apply') && updates.length) {
  for (let i = 0; i < updates.length; i += 400) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: LLC, requestBody: { valueInputOption: 'USER_ENTERED', data: updates.slice(i, i + 400) },
    });
  }
  console.log('APPLIED');
} else {
  console.log('DRY RUN — add --apply');
}
