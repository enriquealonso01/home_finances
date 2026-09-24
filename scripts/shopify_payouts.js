#!/usr/bin/env node
// shopify_payouts.js — v2 (2026-09-21): ingest Shopify (Krendora) paid payouts
// DIRECTLY into the Revenue + Expenses tabs. LLC Transactions is DEPRECATED —
// this script never reads or writes it.
//
//   node scripts/shopify_payouts.js [--apply] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//
// Booking model (TAX-PLAN §5.2):
//   per paid payout → TWO rows:
//     1) Revenue row — net payout amount, Sch C P1, Source=Shopify
//     2) Expense row — Shopify processing fee, Sch C line 10 (Commissions and fees)
//   Idempotent on Ref/ID: `shopify-payout:<id>` / `shopify-fee:<id>`.
//   After writing, run build_expenses_revenue.js --apply to refresh Summary.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  ROOT, sheetsClient, taxRules,
} from './tax_ledger.js';

dotenv.config({ path: '/root/aidp/.env' }); // SHOPIFY_SHOP / CLIENT_ID / CLIENT_SECRET

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const argOf = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const FROM = argOf('--from', '2026-01-01');
const TO = argOf('--to', new Date().toISOString().slice(0, 10));

const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = '2024-01';

// ─── 1. pull paid payouts from Shopify Admin API ─────────────────────────────
async function shopifyToken() {
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Shopify oauth failed (HTTP 403)');
  if (!res.ok) throw new Error(`Shopify oauth failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function pullPayouts(token) {
  const out = [];
  let url = `https://${SHOP}/admin/api/${API_VERSION}/shopify_payments/payouts.json?status=paid&limit=50`;
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) throw new Error(`payouts fetch failed: HTTP ${res.status}`);
    const page = (await res.json()).payouts || [];
    out.push(...page);
    const link = res.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return out;
}

console.log(`Shopify payout ingestion ${FROM} → ${TO}  apply=${apply}`);
const token = await shopifyToken();
const payouts = (await pullPayouts(token))
  .filter(p => p.status === 'paid')
  .filter(p => p.date >= FROM && p.date <= TO)
  .sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
console.log(`Paid payouts pulled from Shopify: ${payouts.length}`);

// sanity: identity check amount == gross - fee (counts of mismatches only)
let identityBad = 0;
for (const p of payouts) {
  const s = p.summary || {};
  const gross = parseFloat(s.charges_gross_amount || 0) - parseFloat(s.refunds_gross_amount || 0)
    + parseFloat(s.adjustments_gross_amount || 0) + parseFloat(s.reserved_funds_gross_amount || 0)
    + parseFloat(s.retried_payouts_gross_amount || 0);
  const fees = parseFloat(s.charges_fee_amount || 0) + parseFloat(s.refunds_fee_amount || 0)
    + parseFloat(s.adjustments_fee_amount || 0) + parseFloat(s.reserved_funds_fee_amount || 0)
    + parseFloat(s.retried_payments_fee_amount || s.retried_payouts_fee_amount || 0);
  if (Math.abs(gross - fees - parseFloat(p.amount)) > 0.01) { identityBad++; p._identityBad = true; }
  if (p._identityBad) console.error(`  MISMATCH payout ${p.id} ${p.date}: gross-fee=${(gross - fees).toFixed(2)} vs amount=${p.amount} — SKIPPED, needs manual review`);
}
console.log(`Payout identity checks failed (gross − fees ≠ amount): ${identityBad}`);
if (identityBad > 0) {
  console.error('ABORTING current payouts — but booking the ones that passed identity check.');
  console.error('NOTE: weekly cron proceeds with clean payouts; flagged payouts stay unbooked for manual review.');
}

// ─── 2. read Revenue + Expenses tabs for idempotency ──────────────────────────
const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const existingIds = new Set();
for (const tab of ['Revenue', 'Expenses']) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: LLC, range: `${tab}!A2:K`, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  for (const r of (res.data.values || [])) if (r[9]) existingIds.add(String(r[9]));
}

// ─── 3. build rows (2 per payout) ─────────────────────────────────────────────
const shopifyLine = taxRules.category_map.Shopify;       // P1 income
const platformLine = taxRules.category_map['Platform Fees']; // line 10
if (!shopifyLine || !platformLine) { console.error('tax_rules.json missing Shopify / Platform Fees mappings'); process.exit(1); }

const CARD = 'Shopify Krendora';
const revRows = [], expRows = [];
let dupes = 0;
for (const p of payouts) {
  if (p._identityBad) continue; // flagged payouts stay unbooked for manual review
  const incomeKey = `shopify-payout:${p.id}`;
  const feeKey = `shopify-fee:${p.id}`;
  if (existingIds.has(incomeKey) && existingIds.has(feeKey)) { dupes++; continue; }
  if (existingIds.has(incomeKey) !== existingIds.has(feeKey)) {
    console.error(`ABORTING — payout ${p.id} is half-booked (one of income/fee row present). Manual fix required.`);
    process.exit(1);
  }
  const amount = parseFloat(p.amount);
  const s = p.summary || {};
  const fee = parseFloat(s.charges_fee_amount || 0) + parseFloat(s.refunds_fee_amount || 0)
    + parseFloat(s.adjustments_fee_amount || 0) + parseFloat(s.reserved_funds_fee_amount || 0)
    + parseFloat(s.retried_payouts_fee_amount || 0);

  revRows.push({
    id: incomeKey, date: p.date, amount,
    desc: `Shopify payout ${p.id} (Krendora)`,
    scline: '1', sclabel: 'Gross receipts / sales',
    source: 'Shopify', card: CARD, review: '', notes: `payout_id ${p.id}; status paid; line 1 per Enrique 2026-09-22 (was P1)`, personal: false,
  });
  expRows.push({
    id: feeKey, date: p.date, amount: fee,
    desc: `Shopify processing fee (payout ${p.id})`,
    scline: String(platformLine.line), sclabel: 'Commissions and fees',
    source: 'Shopify', card: CARD, review: '', notes: `payout_id ${p.id}; Schedule C line 10`, personal: false,
  });
}
console.log(`Payouts already ingested (both rows present): ${dupes}`);
console.log(`New rows to append: ${revRows.length} revenue + ${expRows.length} expense`);
const byLine = {};
for (const r of [...revRows, ...expRows]) byLine[`line ${r.scline}`] = (byLine[`line ${r.scline}`] || 0) + 1;
console.log(`  by Schedule C line:`, byLine);

if (!apply) { console.log('\nDRY RUN — re-run with --apply to write.'); process.exit(0); }
if (revRows.length + expRows.length === 0) { console.log('Nothing to write.'); process.exit(0); }

// ─── 4. append to Revenue + Expenses ──────────────────────────────────────────
const toValues = x => [[x.date, x.desc, x.amount, x.scline, x.sclabel, x.source, x.card, x.review, x.notes, x.id, x.personal ? 'TRUE' : '']];
for (const [tab, list] of [['Revenue', revRows], ['Expenses', expRows]]) {
  if (!list.length) continue;
  await sheets.spreadsheets.values.append({
    spreadsheetId: LLC, range: `${tab}!A1`, valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS', requestBody: { values: list.flatMap(toValues) },
  });
}
console.log(`Wrote ${revRows.length} revenue + ${expRows.length} expense rows.`);
console.log('Now run: node scripts/build_expenses_revenue.js --apply  (refresh sort + Summary)');

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/shopify_payouts_state.json'), JSON.stringify({
  last_run: new Date().toISOString(),
  window: { from: FROM, to: TO },
  payouts_pulled: payouts.length,
  already_ingested: dupes,
  rows_appended: revRows.length + expRows.length,
  identity_failures: identityBad,
  payout_ids: payouts.map(p => String(p.id)),
}, null, 2));
console.log('State written to data/shopify_payouts_state.json');
console.log('Done.');
