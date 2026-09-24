import { sheetsClient } from '/root/projects/home_finances/scripts/tax_ledger.js';
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const dry = !process.argv.includes('--apply');

const meta = await sheets.spreadsheets.get({ spreadsheetId: LLC });
const byTitle = t => meta.data.sheets.find(s => s.properties.title === t);
const EXP = byTitle('Expenses').properties.sheetId;
const REV = byTitle('Revenue').properties.sheetId;

// ---- Summary V2 layout (formulas auto-update as rows are appended) -------------
// A  label | B amount | C note
const R = {}; let row = 1;
const W = []; // {range, values}
function section(title) { W.push({ r: row, v: [[title], []] }); row += 2; }
function line(label, formula, note = '') { W.push({ r: row, v: [[label, formula, note]] }); R[label] = row; row += 1; }
function blank() { row += 1; }

section('LLC P&L SUMMARY — auto-updates as Expenses/Revenue rows are added');
line('Report generated', '"" ', 'all figures pulled live from Expenses + Revenue tabs');
blank();

section('REVENUE (by source)');
const RSRC = ['Ticketflipping', 'Shopify', 'Facebook', 'Chase', 'Citi', 'Manual', 'Manual-2025sheet'];
for (const s of RSRC) line(s, `=SUMIF(Revenue!F:F,"${s}",Revenue!C:C)`);
line('TOTAL REVENUE', `=SUMIF(Revenue!F:F,"<>",Revenue!C:C)`, 'all revenue rows');
blank();

section('EXPENSES (by category)');
const ELBL = [
  ['Advertising', 'Line 8 — Advertising'],
  ['Car expenses', 'Line 9 — Car & vehicle'],
  ['Commissions and fees', 'Line 10 — Commissions & fees'],
  ['Cost of goods sold', 'Line 4 — Cost of goods sold'],
  ['Home office interview', 'Line 30 — Home office'],
  ['Meals', 'Line 24b — Meals'],
  ['Taxes and licenses', 'Line 23 — Taxes & licenses'],
  ['Travel', 'Line 24a — Travel'],
  ['Utilities', 'Line 25 — Utilities'],
  ['Other expenses', 'Line 27a — Other expenses'],
];
for (const [label, pretty] of ELBL) line(pretty, `=SUMIF(Expenses!E:E,"${label}",Expenses!C:C)-SUMIFS(Expenses!C:C,Expenses!E:E,"${label}",Expenses!K:K,TRUE)`, 'personal-flagged excluded');
line('Uncategorized (needs your Review)', '=SUMIFS(Expenses!C:C,Expenses!E:E,"",Expenses!K:K,FALSE)-SUMIFS(Expenses!C:C,Expenses!H:H,"Y",Expenses!E:E,"",Expenses!K:K,FALSE)', 'no Sch C line yet');
line('TOTAL BUSINESS EXPENSES', '=SUMIFS(Expenses!C:C,Expenses!K:K,FALSE)', 'excludes Personal=TRUE rows');
blank();

section('BOTTOM LINE');
line('NET PROFIT (est.)', `=B${R['TOTAL REVENUE']}-B${R['TOTAL BUSINESS EXPENSES']}`);
line('Est. self-employment tax', `=B${R['NET PROFIT (est.)']}*0.1413`, '13.9% effective SE tax ~ 92.35% x 15.3%');
line('Est. set-aside w/ income tax', `=B${R['NET PROFIT (est.)']}*0.25`, '25% rule-of-thumb');
blank();

section('DATA HEALTH');
line('Expense rows', '=COUNTA(Expenses!A2:A)-COUNTBLANK(Expenses!C2:C)+COUNTIF(Expenses!C2:C,"<>")', '');
line('Revenue rows', '=COUNTIF(Revenue!C2:C,">0")+COUNTIF(Revenue!C2:C,"<0")', '');
line('Rows flagged Personal', '=COUNTIF(Expenses!K2:K,TRUE)', 'excluded from totals');
line('Rows awaiting your Review (Y)', '=COUNTIF(Expenses!H2:H,"Y")', 'decide business vs personal');
line('Duplicate check (should be 0)', '=SUMPRODUCT(--(COUNTIF(Revenue!J2:J10000,Revenue!J2:J10000)>1))', 'dup Ref/IDs in Revenue');
blank();

section('PIE CHARTS (embedded below via API)');
W.push({ r: row, v: [['▼ Income by source / ▼ Expenses by category — charts anchored under this row']] }); row += 1;

if (dry) { console.log('DRY RUN — rows to write:', row - 1); W.forEach(w => console.log(String(w.r).padStart(3), JSON.stringify(w.v[0]).slice(0, 100))); process.exit(0); }

// create/replace tab
if (byTitle('Summary V2')) {
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: LLC, requestBody: { requests: [{ deleteSheet: { sheetId: byTitle('Summary V2').properties.sheetId } }] } });
}
await sheets.spreadsheets.batchUpdate({ spreadsheetId: LLC, requestBody: { requests: [{ addSheet: { properties: { title: 'Summary V2', gridProperties: { rowCount: 80, columnCount: 4 } } } }] } });
const meta2 = await sheets.spreadsheets.get({ spreadsheetId: LLC });
const S2 = meta2.data.sheets.find(s => s.properties.title === 'Summary V2').properties.sheetId;

const put = async (fn, tag) => {
  for (let i = 0; i < 6; i++) {
    try { return await fn(); }
    catch (e) { if (!/Quota|RESOURCE_EXHAUSTED|429/i.test(e.message + e.code)) throw e; console.log('quota wait…', tag); await new Promise(r => setTimeout(r, 20000)); }
  }
  throw new Error('quota retries exhausted: ' + tag);
};
for (const w of W) {
  await put(() => sheets.spreadsheets.values.update({ spreadsheetId: LLC, range: `Summary V2!A${w.r}`, valueInputOption: 'USER_ENTERED', requestBody: { values: w.v } }), `row ${w.r}`);
}
console.log('cells written:', W.length);

// formatting: bold section titles, freeze, currency on B
const fmt = [];
// currency format whole B column of the table area
fmt.push({ repeatCell: { range: { sheetId: S2, startRowIndex: 1, endRowIndex: 80, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } });
for (const w of W) {
  const v0 = w.v[0][0] || '';
  if (!w.v[0][1] && v0 && !v0.startsWith('▼')) {
    fmt.push({ repeatCell: { range: { sheetId: S2, startRowIndex: w.r - 1, endRowIndex: w.r, startColumnIndex: 0, endColumnIndex: 4 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, backgroundColor: { red: 0.85, green: 0.9, blue: 1 } } }, fields: 'userEnteredFormat.textFormat,userEnteredFormat.backgroundColor' } });
  }
}
// bold totals
for (const lbl of ['TOTAL REVENUE', 'TOTAL BUSINESS EXPENSES', 'NET PROFIT (est.)']) {
  fmt.push({ repeatCell: { range: { sheetId: S2, startRowIndex: R[lbl] - 1, endRowIndex: R[lbl], startColumnIndex: 0, endColumnIndex: 2 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat' } });
}
fmt.push({ updateSheetProperties: { properties: { sheetId: S2, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
await sheets.spreadsheets.batchUpdate({ spreadsheetId: LLC, requestBody: { requests: fmt } });

// charts
const charts = [
  { req: 'pie', title: 'Income by Source', domain: { sheetId: REV, startRowIndex: 1, endColumnIndex: 6, endRowIndex: 2, startColumnIndex: 5 }, range: { sheetId: REV, startRowIndex: 1, endColumnIndex: 3, endRowIndex: 2, startColumnIndex: 2 }, anchorRow: 33, anchorCol: 0 },
];
// Build charts from the summary's own label/amount cells instead (cleaner)
const chartReqs = [];
const mkChart = (title, rowStart, rowEnd) => ({
  addChart: {
    chart: {
      spec: {
        title,
        pieChart: { legendPosition: 'RIGHT_LEGEND', domain: { sourceRange: { sources: [{ sheetId: S2, startRowIndex: rowStart, endRowIndex: rowEnd, startColumnIndex: 0, endColumnIndex: 1 }] } }, series: { sourceRange: { sources: [{ sheetId: S2, startRowIndex: rowStart, endRowIndex: rowEnd, startColumnIndex: 1, endColumnIndex: 2 }] } } },
      },
      position: { overlayPosition: { anchorCell: { sheetId: S2, rowIndex: 33, columnIndex: 0 + chartReqs.length * 1 }, offsetXPixels: chartReqs.length * 460, offsetYPixels: 0 } },
    },
  },
});
const revStart = R['Ticketflipping'] - 1, revEnd = R['TOTAL REVENUE'] - 1;
const expStart = R['Line 8 — Advertising'] - 1, expEnd = R['Uncategorized (needs your Review)'];
chartReqs.push(mkChart('Income by Source', revStart, revEnd));
chartReqs.push(mkChart('Expenses by Category', expStart, expEnd));
const chResp = await sheets.spreadsheets.batchUpdate({ spreadsheetId: LLC, requestBody: { requests: chartReqs } });
console.log('APPLIED — Summary V2 built.', chResp.data.replies?.length, 'charts added');
