#!/usr/bin/env node
// weekly_pull.mjs — weekly LLC books ingest (cron driver, 2026-09-21)
// Pulls last ~2 weeks of txns from all Plaid business accounts (Chase 5441 credit,
// Citi card, Chase checking 2502) + Shopify payouts, writes into Expenses/Revenue,
// then rebuilds Summary V2 data and prints a report for Enrique.
// Idempotent: plaid:<txid> / shopify-payout:<id> keys mean re-runs never duplicate.
import { execFileSync } from 'node:child_process';

const ROOT = '/root/projects/home_finances';
const run = (cmd, args) => {
  try {
    const out = execFileSync('node', [cmd, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 480000, env: process.env });
    return out;
  } catch (e) {
    return `ERROR in ${cmd}: ${e.message.slice(0, 300)}\n${(e.stdout || '').slice(-400)}`;
  }
};

const today = new Date();
const iso = d => d.toISOString().slice(0, 10);
const twoWeeksAgo = new Date(today.getTime() - 14 * 86400000);
const month = iso(today).slice(0, 7); // run_month pulls the whole month; idempotent keys protect us
const prevMonth = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))).slice(0, 7);

console.log(`=== WEEKLY LLC PULL ${iso(today)} (window back to ${iso(twoWeeksAgo)}) ===`);
// month boundary safety: pull current + previous month so a 14-day window never misses rows
const r1 = run('scripts/run_month.js', [month, '--apply']);
console.log(`-- run_month ${month}:\n${r1.split('\n').filter(l => /Appended|SKIP|Error|error/i.test(l)).join('\n') || r1.slice(-300)}`);
const r1b = iso(today).slice(8) <= '07' ? run('scripts/run_month.js', [prevMonth, '--apply']) : '';
if (r1b) console.log(`-- run_month ${prevMonth} (boundary safety):\n${r1b.split('\n').filter(l => /Appended|SKIP|Error/i.test(l)).join('\n')}`);

const r2 = run('scripts/shopify_payouts.js', ['--from', iso(twoWeeksAgo)]);
console.log(`-- shopify_payouts:\n${r2.split('\n').filter(l => /New rows|payout|Error/i.test(l)).slice(-4).join('\n')}`);

const r3 = run('scripts/build_expenses_revenue.js', ['--apply']);
console.log(`-- rebuild:\n${r3.split('\n').filter(l => /Expenses:|Revenue by|Summary:|APPLIED|negative/i.test(l)).join('\n')}`);
console.log('=== DONE ===');
