#!/usr/bin/env node
// autocat.js — auto-categorize uncategorized expense rows using config/vendor_autocat.json
// Learned from Enrique's 2026-10 review sweep. Usage: node scripts/autocat.js [--apply]
import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import { sheetsClient } from './tax_ledger.js';

const CONFIG_PATH = new URL('../config/vendor_autocat.json', import.meta.url);
const APPLY = process.argv.includes('--apply');

function matchDesc(desc, rule) {
  const d = String(desc || '').toUpperCase().replace(/^(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER) 20\d\d - /, '');
  return d.includes(rule.pattern.toUpperCase());
}
function resolve(desc, rule) {
  if (rule.sub) {
    const hit = rule.sub.find(s => s.match === 'CONTAINS' && matchDesc(desc, s));
    const chosen = hit || rule.sub.find(s => s.match === 'ELSE');
    return chosen || null;
  }
  return rule;
}

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const sheets = await sheetsClient();
const sid = process.env.LLC_SHEET_ID;

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: sid, range: 'Expenses!A2:L950', valueRenderOption: 'UNFORMATTED_VALUE',
});
const rows = res.data.values || [];
const updates = [];
let matched = 0, unmatched = 0;

rows.forEach((r, i) => {
  const row = i + 2;
  const desc = r[1] || '';
  const scl = String(r[3] || '').trim();
  const personal = String(r[10] || '').toUpperCase() === 'TRUE';
  if (scl || personal) return; // already categorized
  const rule = cfg.rules.find(x => x.match === 'CONTAINS' && matchDesc(desc, x));
  if (!rule) { unmatched++; return; }
  const verdict = resolve(desc, rule);
  if (!verdict) { unmatched++; return; }
  matched++;
  updates.push({ row, desc, scl: verdict.scl, label: verdict.label, personal: verdict.personal, project: verdict.project });
});

console.log(`Autocat: matched ${matched}, unmatched (left for review) ${unmatched}${APPLY ? ' — APPLYING' : ' — dry run'}`);

for (const u of updates) {
  if (!APPLY) { console.log(`  Expenses:${u.row} | ${String(u.desc).slice(0,40)} | -> ${u.personal ? 'PERSONAL' : u.scl + ' ' + (u.label||'')}`); continue; }
  const vals = {};
  const body = {};
  if (u.personal) body.personal = 'TRUE';
  else { body.scl = u.scl; body.label = u.label; }
  const cells = [];
  const note = 'autocat (learned from Enrique 2026-10 review)';
  if (u.personal) {
    cells.push({ range: `Expenses!K${u.row}`, values: [['TRUE']] }, { range: `Expenses!I${u.row}`, values: [[note]] });
  } else {
    cells.push({ range: `Expenses!D${u.row}`, values: [[u.scl]] }, { range: `Expenses!E${u.row}`, values: [[u.label]] }, { range: `Expenses!I${u.row}`, values: [[note]] });
  }
  if (u.project) cells.push({ range: `Expenses!L${u.row}`, values: [[u.project]] });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sid, resource: { valueInputOption: 'USER_ENTERED', data: cells },
  });
  console.log(`  Expenses:${u.row} | ${String(u.desc).slice(0,40)} | ${u.personal ? 'PERSONAL' : u.scl + ' ' + (u.label||'')}`);
}
console.log(APPLY ? 'Done. Run build_expenses_revenue.js --apply to refresh Summary.' : 'Dry run only — pass --apply to write.');
