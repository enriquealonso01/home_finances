import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const KEY_FILE = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ? process.env.GOOGLE_APPLICATION_CREDENTIALS
  : path.join(ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

const TRAINING_TABS = ['Jan 2026', 'Feb 2026', 'Mar 2026'];

const rows = [];
for (const tab of TRAINING_TABS) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.FAMILY_SHEET_ID,
    range: `${tab}!A2:G500`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const vals = resp.data.values || [];
  for (const r of vals) {
    const [desc, category, type, card, costo, fecha, notas] = r;
    if (!desc || !category) continue;
    rows.push({ tab, desc: String(desc).trim(), category: String(category).trim(), type, card, costo, fecha, notas });
  }
}

console.log(`Loaded ${rows.length} labeled rows from ${TRAINING_TABS.join(', ')}`);

const merchantBuckets = new Map();
for (const r of rows) {
  const keyRaw = normalize(r.desc);
  if (!keyRaw) continue;
  if (!merchantBuckets.has(keyRaw)) merchantBuckets.set(keyRaw, []);
  merchantBuckets.get(keyRaw).push(r);
}

const merchantRules = {};
const ambiguous = [];

for (const [key, group] of merchantBuckets.entries()) {
  const tally = {};
  for (const r of group) tally[r.category] = (tally[r.category] || 0) + 1;
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const totalForKey = group.length;
  const confidence = top[1] / totalForKey;
  merchantRules[key] = {
    category: top[0],
    confidence: Number(confidence.toFixed(2)),
    samples: totalForKey,
    distribution: Object.fromEntries(sorted),
    typical_card: pickTypicalCard(group),
    sample_desc: group[0].desc,
  };
  if (confidence < 0.7 && totalForKey >= 2) {
    ambiguous.push({ key, distribution: tally, samples: totalForKey });
  }
}

const categoriesSeen = {};
for (const r of rows) categoriesSeen[r.category] = (categoriesSeen[r.category] || 0) + 1;

const output = {
  version: 1,
  trained_on: TRAINING_TABS,
  total_rows: rows.length,
  categories_seen: categoriesSeen,
  ambiguous_count: ambiguous.length,
  ambiguous_top: ambiguous.sort((a, b) => b.samples - a.samples).slice(0, 15),
  merchant_rules: merchantRules,
};

const outPath = path.join(ROOT, 'config/categories.json');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nWrote ${outPath}`);
console.log(`  Unique merchant keys: ${Object.keys(merchantRules).length}`);
console.log(`  Categories used: ${Object.keys(categoriesSeen).length}`);
console.log(`  Ambiguous keys (confidence <0.7 with >=2 samples): ${ambiguous.length}`);
console.log(`\nCategory counts:`);
for (const [c, n] of Object.entries(categoriesSeen).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(4)}  ${c}`);
}
if (ambiguous.length) {
  console.log(`\nTop ambiguous merchant keys:`);
  for (const a of ambiguous.sort((a, b) => b.samples - a.samples).slice(0, 10)) {
    console.log(`  "${a.key}"  (${a.samples} samples)  ${JSON.stringify(a.distribution)}`);
  }
}

function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTypicalCard(group) {
  const tally = {};
  for (const r of group) if (r.card) tally[r.card] = (tally[r.card] || 0) + 1;
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || null;
}
