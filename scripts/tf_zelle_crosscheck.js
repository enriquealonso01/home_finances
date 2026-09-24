#!/usr/bin/env node
// tf_zelle_crosscheck.js — read-only: pull Chase checking Zelle credits from TICKET FLIPPING LLC
// since link date (2026-03-08) and compare against Revenue tab legacy-rev TF rows.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { sheetsClient } from './tax_ledger.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const config = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
  baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET } },
});
const client = new PlaidApi(config);
const tokens = JSON.parse(fs.readFileSync('secrets/plaid_tokens.json', 'utf-8'));
const CHASE_ITEM = '4pYVVL3wgxTJMZ0yeoL6u3Xg3o0oopsA74nky';
const CHECKING = 'waXyyz8g5Lhj3e4zXNAyCX5870jLDNUOQQ4j3';

const start = '2026-03-08';
const today = new Date().toISOString().slice(0, 10);

const txns = [];
let offset = 0;
for (;;) {
  const resp = await client.transactionsGet({
    access_token: tokens[CHASE_ITEM].access_token,
    start_date: start, end_date: today,
    options: { account_ids: [CHECKING], count: 500, offset },
  });
  txns.push(...resp.data.transactions);
  if (txns.length >= resp.data.total_transactions) break;
  offset = txns.length;
}
console.log(`chase checking txns since ${start}: ${txns.length}`);

const tf = txns.filter(t =>
  (t.amount < 0) && /ticket\s*flipping|ticketflipping/i.test(`${t.name} ${t.merchant_name || ''} ${JSON.stringify(t.personal_finance_category || {})}`));
// also show all inflow credits for manual eyeball
const credits = txns.filter(t => t.amount < 0).sort((a, b) => a.date.localeCompare(b.date));
console.log('--- all credits (date | amount-sign-flipped | name) ---');
credits.forEach(t => console.log(t.date, '|', (-t.amount).toFixed(2), '|', t.name));

const sheets = await sheetsClient();
const LLC = process.env.LLC_SHEET_ID;
const rev = await sheets.spreadsheets.values.get({
  spreadsheetId: LLC, range: 'Revenue!A1:J200', valueRenderOption: 'UNFORMATTED_VALUE' });
const tabTF = (rev.data.values || []).slice(1)
  .filter(r => r[5] === 'Ticketflipping' && r[0] >= start)
  .map(r => ({ date: r[0], ref: r[9] }));
console.log('--- Revenue tab TF rows since', start, '---');
tabTF.forEach(r => console.log(r.date, r.ref));

// 1:1 match by date (nearest)
const bankDates = tf.map(t => t.date).sort();
const tabDates = tabTF.map(r => r.date).sort();
const matched = [], missingInTab = [...bankDates], missingInBank = [...tabDates];
for (const d of bankDates) {
  const i = missingInBank.indexOf(d);
  if (i >= 0) { matched.push(d); missingInTab.splice(missingInTab.indexOf(d), 1); missingInBank.splice(i, 1); }
}
console.log('BANK_TF_CREDITS:', bankDates.length);
console.log('MATCHED_BY_DATE:', matched.length);
console.log('BANK_NOT_IN_TAB:', JSON.stringify(missingInTab));
console.log('TAB_NOT_IN_BANK:', JSON.stringify(missingInBank));
console.log('POST_AUG10_BANK_TF:', JSON.stringify(bankDates.filter(d => d > '2026-08-10')));
console.log('SEPT_BANK_TF:', JSON.stringify(bankDates.filter(d => d.startsWith('2026-09'))));
