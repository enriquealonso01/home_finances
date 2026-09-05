import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const KEY_FILE = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ? process.env.GOOGLE_APPLICATION_CREDENTIALS
  : path.join(ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS);

const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
const sheets = google.sheets({ version: 'v4', auth });

const TABS = ['Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026'];
const all = [];
for (const tab of TABS) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.FAMILY_SHEET_ID,
    range: `${tab}!A2:G200`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = resp.data.values || [];
  for (const r of rows) {
    const [desc, category, type, card, amount, dateSerial] = r;
    if (!desc || !category) continue;
    if (typeof amount !== 'number') continue;
    all.push({ tab, desc: String(desc), category: String(category).trim(), type, card, amount, dateSerial });
  }
}

const expenses = all.filter(t => t.type === 'Expense');
const profits = all.filter(t => t.type === 'Profit');
const savings = all.filter(t => t.type === 'Savings');

const byCategory = {};
for (const t of expenses) {
  byCategory[t.category] = byCategory[t.category] || { total: 0, count: 0, byCard: {}, samples: [] };
  byCategory[t.category].total += t.amount;
  byCategory[t.category].count++;
  byCategory[t.category].byCard[t.card] = (byCategory[t.category].byCard[t.card] || 0) + t.amount;
  if (byCategory[t.category].samples.length < 8) byCategory[t.category].samples.push({ desc: t.desc, amount: t.amount, tab: t.tab });
}

const totalExpense = expenses.reduce((s, t) => s + t.amount, 0);
const totalProfit = profits.reduce((s, t) => s + t.amount, 0);
const totalSavings = savings.reduce((s, t) => s + t.amount, 0);

console.log(`\n=== Totals across ${TABS.join(', ')} ===`);
console.log(`Total expenses: $${totalExpense.toFixed(2)}`);
console.log(`Total profit:   $${totalProfit.toFixed(2)}`);
console.log(`Total savings:  $${totalSavings.toFixed(2)}`);
console.log(`Net:            $${(totalProfit - totalExpense - totalSavings).toFixed(2)}\n`);

console.log(`=== Expenses by category (sorted) ===`);
const sorted = Object.entries(byCategory).sort((a, b) => b[1].total - a[1].total);
for (const [cat, info] of sorted) {
  const pct = (info.total / totalExpense) * 100;
  console.log(`${cat.padEnd(24)} $${info.total.toFixed(2).padStart(10)}  (${pct.toFixed(1).padStart(4)}%)  ${info.count} txns`);
}

console.log(`\n=== Drill-down: top 6 discretionary categories ===`);
const discretionary = ['Take out/Uber Eats', 'Comidas EJ', 'Comida/Salida Amigos', 'Shopping', 'Exceptions', 'Personal'];
for (const cat of discretionary) {
  const info = byCategory[cat];
  if (!info) continue;
  console.log(`\n--- ${cat}: $${info.total.toFixed(2)} (${info.count} txns, avg $${(info.total / info.count).toFixed(2)}) ---`);
  // Top descriptions
  const byDesc = {};
  for (const t of expenses.filter(t => t.category === cat)) {
    byDesc[t.desc] = (byDesc[t.desc] || 0) + t.amount;
  }
  const topDesc = Object.entries(byDesc).sort((a, b) => b[1] - a[1]).slice(0, 6);
  for (const [d, amt] of topDesc) console.log(`  $${amt.toFixed(2).padStart(8)}  ${d.slice(0, 50)}`);
}

console.log(`\n=== Take out / Uber Eats monthly ===`);
const monthlyTakeout = {};
for (const t of expenses.filter(t => t.category === 'Take out/Uber Eats')) {
  monthlyTakeout[t.tab] = (monthlyTakeout[t.tab] || 0) + t.amount;
}
for (const tab of TABS) console.log(`  ${tab}: $${(monthlyTakeout[tab] || 0).toFixed(2)}`);

console.log(`\n=== Comidas EJ monthly ===`);
const monthlyEJ = {};
for (const t of expenses.filter(t => t.category === 'Comidas EJ')) {
  monthlyEJ[t.tab] = (monthlyEJ[t.tab] || 0) + t.amount;
}
for (const tab of TABS) console.log(`  ${tab}: $${(monthlyEJ[tab] || 0).toFixed(2)}`);
