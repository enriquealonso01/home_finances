import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const args = process.argv.slice(2);
const month = args.find(a => /^\d{4}-\d{2}$/.test(a));
const apply = args.includes('--apply');
const familyOnly = args.includes('--family-only');

if (!month) {
  console.error('Usage: node scripts/run_month.js YYYY-MM [--apply]');
  process.exit(1);
}

const [year, mo] = month.split('-').map(Number);
const startDate = `${year}-${String(mo).padStart(2, '0')}-01`;
const lastDay = new Date(year, mo, 0).getDate();
const endDate = `${year}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
const monthShort = new Date(year, mo - 1, 1).toLocaleString('en-US', { month: 'short' });
const monthLong = new Date(year, mo - 1, 1).toLocaleString('en-US', { month: 'long' });
const familyTab = `${monthShort} ${year}`;

console.log(`Backfill ${month}  range ${startDate} → ${endDate}  apply=${apply}`);
console.log(`Family tab target: "${familyTab}"\n`);

const KEY_FILE = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ? process.env.GOOGLE_APPLICATION_CREDENTIALS
  : path.join(ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS);

const accountsConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/accounts.json'), 'utf-8'));
const categoriesConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/categories.json'), 'utf-8'));
const acctById = Object.fromEntries(accountsConfig.accounts.map(a => [a.account_id, a]));

const TOKENS_FILE = path.join(ROOT, 'secrets/plaid_tokens.json');
const tokens = fs.existsSync(TOKENS_FILE) ? JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')) : {};

const plaidApi = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
}));

const plaidTxns = [];
for (const [item_id, t] of Object.entries(tokens)) {
  let offset = 0; const count = 500;
  while (true) {
    const resp = await plaidApi.transactionsGet({
      access_token: t.access_token,
      start_date: startDate,
      end_date: endDate,
      options: { offset, count },
    });
    plaidTxns.push(...resp.data.transactions);
    if (resp.data.transactions.length < count) break;
    offset += count;
    if (offset >= resp.data.total_transactions) break;
  }
}
console.log(`Plaid pulled: ${plaidTxns.length} transactions across ${Object.keys(tokens).length} institution(s)`);

const APPLE_DIR = path.join(ROOT, 'data/apple_card');
const appleAcct = accountsConfig.accounts.find(a => a.source === 'csv' && a.institution === 'Apple Card');
const appleRows = [];
if (fs.existsSync(APPLE_DIR)) {
  for (const f of fs.readdirSync(APPLE_DIR).filter(x => x.endsWith('.csv'))) {
    const text = fs.readFileSync(path.join(APPLE_DIR, f), 'utf-8');
    const rows = parse(text, { columns: true, skip_empty_lines: true });
    for (const r of rows) {
      const [m, d, y] = r['Transaction Date'].split('/');
      const iso = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      if (iso >= startDate && iso <= endDate) appleRows.push({ ...r, _iso: iso });
    }
  }
}
console.log(`Apple Card CSV: ${appleRows.length} transactions in ${month}\n`);

// ─── filters ─────────────────────────────────────────────────────────────────
const SKIP_NAME = [
  /online transfer/i,
  /^payment to (chase|apple|discover|amex|capital one|amer)/i,
  /^apple card$/i,
  /apple gs savings/i,
  /discover e-payment/i,
  /jpmorgan chase ext trnsfr/i,
  /atm withdrawal/i,
  /atm fee/i,
  /^interest paid$/i,
  /^interest earned$/i,
  /internet transfer/i,
  /^ett$/i,
  /^deposit$/i,
];

function shouldSkipPlaid(tx, acct, matchedTxIds) {
  if (acct.subtype === 'savings') return true;
  if (matchedTxIds && matchedTxIds.has(tx.transaction_id)) return true;
  const name = String(tx.name || '');
  for (const p of SKIP_NAME) if (p.test(name)) return true;
  const pfc = tx.personal_finance_category?.primary;
  const pfcd = tx.personal_finance_category?.detailed || '';
  if (pfc === 'TRANSFER_IN' || pfc === 'TRANSFER_OUT') return true;
  if (pfc === 'LOAN_PAYMENTS' && /CREDIT_CARD/.test(pfcd)) return true;
  return false;
}

// Pair up Marcus / Chase Savings inflows with their Chase outflows so we can emit
// a single "Savings Account" row in the family sheet instead of dropping the move.
const savingsAccountIds = new Set(
  accountsConfig.accounts.filter(a => a.subtype === 'savings').map(a => a.account_id)
);

function pairSavingsTransfers(plaidTxns) {
  const matchedTxIds = new Set();
  const syntheticRows = [];

  for (const inTx of plaidTxns) {
    if (!savingsAccountIds.has(inTx.account_id)) continue;
    // Plaid: positive amount = money OUT of the account. So a savings INFLOW has a negative amount.
    if (inTx.amount >= 0) continue;
    if (/interest/i.test(inTx.name || '')) continue;

    const targetAmount = -inTx.amount;
    let candidate = null;
    let bestDiff = Infinity;
    for (const outTx of plaidTxns) {
      if (matchedTxIds.has(outTx.transaction_id)) continue;
      if (savingsAccountIds.has(outTx.account_id)) continue;
      if (Math.abs(outTx.amount - targetAmount) > 0.01) continue;
      const dayDiff = Math.abs((new Date(outTx.date) - new Date(inTx.date)) / 86400000);
      if (dayDiff > 3) continue;
      if (dayDiff < bestDiff) { bestDiff = dayDiff; candidate = outTx; }
    }

    if (candidate) {
      matchedTxIds.add(candidate.transaction_id);
      matchedTxIds.add(inTx.transaction_id);
      const srcAcct = acctById[candidate.account_id];
      const destAcct = acctById[inTx.account_id];
      const destLabel = destAcct.institution.includes('Marcus')
        ? `Marcus ${destAcct.plaid_name}`
        : destAcct.plaid_name;
      // Marcus "2026 LLC Taxes" set-asides are a tax expense, NOT savings. Tag them
      // "Tax Saving" / Expense so they never count toward grand savings.
      const isTaxSaving = /tax/i.test(destAcct.plaid_name || '');
      syntheticRows.push({
        source: 'savings_pair',
        date: candidate.date,
        description: 'Savings Account',
        merchant: 'Savings Account',
        amount: targetAmount,
        type: isTaxSaving ? 'Expense' : 'Savings',
        account: srcAcct,
        category: isTaxSaving ? 'Tax Saving' : 'Savings',
        confidence: 0.95,
        cls_source: isTaxSaving ? 'tax-saving-pair' : 'savings-pair',
        needs_review: false,
        _notes_extra: destLabel,
      });
    } else {
      console.warn(`  Unmatched savings inflow: ${inTx.name} $${(-inTx.amount).toFixed(2)} on ${inTx.date} → ${acctById[inTx.account_id].plaid_name}`);
    }
  }

  return { matchedTxIds, syntheticRows };
}

const { matchedTxIds, syntheticRows: savingsSyntheticRows } = pairSavingsTransfers(plaidTxns);
console.log(`Matched ${savingsSyntheticRows.length} savings transfer(s) → "Savings Account" rows in family.`);

// Apple Savings is at Goldman Sachs (no Plaid). We can only see the OUTGOING side
// on the source bank (Chase) as "APPLE GS SAVINGS TRANSFER ...". Detect that pattern
// and emit a Savings row directly (no pair-matching since the inbound side is
// invisible). Incoming side (money flowing back from Apple Savings to checking) is
// flagged for review since it's a withdrawal rather than a deposit.
const APPLE_SAVINGS_RE = /apple\s*gs\s*savings|apple savings transfer|gs bank.*savings/i;
for (const tx of plaidTxns) {
  if (!APPLE_SAVINGS_RE.test(tx.name || '')) continue;
  if (matchedTxIds.has(tx.transaction_id)) continue;
  const acct = acctById[tx.account_id];
  if (!acct || acct.subtype === 'savings') continue;
  matchedTxIds.add(tx.transaction_id);
  if (tx.amount > 0) {
    savingsSyntheticRows.push({
      source: 'apple_savings_pattern',
      date: tx.date,
      description: 'Savings Account',
      merchant: 'Savings Account',
      amount: tx.amount,
      type: 'Savings',
      account: acct,
      category: 'Savings',
      confidence: 0.9,
      cls_source: 'apple-savings-out',
      needs_review: false,
      _notes_extra: 'Apple Savings',
    });
  } else {
    savingsSyntheticRows.push({
      source: 'apple_savings_pattern',
      date: tx.date,
      description: 'From Apple Savings',
      merchant: 'Apple Savings withdrawal',
      amount: -tx.amount,
      type: 'Profit',
      account: acct,
      category: 'Other',
      confidence: 0.4,
      cls_source: 'apple-savings-in',
      needs_review: true,
      _notes_extra: 'withdrawal from Apple Savings',
    });
  }
}
const appleCount = savingsSyntheticRows.filter(r => r.cls_source.startsWith('apple-savings')).length;
if (appleCount > 0) console.log(`Detected ${appleCount} Apple Savings transfer(s) from Chase.`);

// ─── custom categorization rules (high-confidence overrides) ─────────────────
const CUSTOM_RULES = [
  // LLC software & infra subs → Business Q (family) / Subscriptions (LLC)
  { match: /(openai|chatgpt|chat gpt)/i,         family: 'Business Q', llc: 'Subscriptions' },
  { match: /^cursor( ai)?/i,                     family: 'Business Q', llc: 'Subscriptions' },
  { match: /^lovable/i,                          family: 'Business Q', llc: 'Subscriptions' },
  { match: /^claude\.?ai/i,                      family: 'Business Q', llc: 'Subscriptions' },
  { match: /^vidu/i,                             family: 'Business Q', llc: 'Subscriptions' },
  { match: /(^fal\b|fal features|fal\.ai)/i,     family: 'Business Q', llc: 'Subscriptions' },
  { match: /(elevenlabs|11labs)/i,               family: 'Business Q', llc: 'Subscriptions' },
  { match: /^kling/i,                            family: 'Business Q', llc: 'Subscriptions' },
  { match: /^(runpod|runway)/i,                  family: 'Business Q', llc: 'Subscriptions' },
  { match: /webshare/i,                          family: 'Business Q', llc: 'Subscriptions' },
  { match: /plaid technologies/i,                family: 'Business Q', llc: 'Subscriptions' },
  { match: /amazon web services|^aws$|aws bill/i,family: 'Business Q', llc: 'Subscriptions' },
  { match: /(uploadpost|upload-?post|^upload$)/i,family: 'Business Q', llc: 'Subscriptions' },
  { match: /^autods/i,                           family: 'Business Q', llc: 'Subscriptions' },
  { match: /thunder co/i,                        family: 'Business Q', llc: 'Subscriptions' },
  { match: /text verified/i,                     family: 'Business Q', llc: 'Subscriptions' },
  { match: /opus clip/i,                         family: 'Business Q', llc: 'Subscriptions' },
  { match: /rendi\.dev/i,                        family: 'Business Q', llc: 'Subscriptions' },
  { match: /(spintax|tax software|fiverr)/i,     family: 'Business Q', llc: 'Subscriptions' },
  { match: /^b66$/i,                             family: 'Business Q', llc: 'Subscriptions' }, // brokerage ticketing tool

  // LLC home-office utilities
  { match: /^at\s*&\s*t|^at\.?nt/i,              family: 'Apartment',  llc: 'Home Office' },
  { match: /^fpl$/i,                             family: 'Apartment',  llc: 'Home Office' },

  // LLC parking
  { match: /river landing parking/i,             family: 'Apartment',  llc: 'Miscellaneous' },

  // Travel / exceptions
  { match: /(american airlines|delta|jetblue|spirit|frontier|united\b)/i, family: 'Exceptions', llc: 'Other' },
  { match: /^turo/i,                             family: 'Exceptions', llc: 'Other' },
  { match: /(las vegas|aria patisserie|aria hotel|mandalay)/i, family: 'Exceptions', llc: 'Other' },
  { match: /uscis chicago/i,                     family: 'Exceptions' },

  // Uber / Lyft / rideshare
  { match: /uber\s*\*?\s*eats/i,                 family: 'Take out/Uber Eats' },
  { match: /^uber\b(?!\s*\*?\s*eats)/i,          family: 'Car' },
  { match: /^lyft/i,                             family: 'Car' },

  // Subscriptions (personal)
  { match: /^apple\.com\/bill|^apple services|^apple$.*subscription/i, family: 'Subscriptions' },
  { match: /apple subscription/i,                family: 'Subscriptions' },
  { match: /^netflix/i,                          family: 'Subscriptions' },
  { match: /^ladder/i,                           family: 'Subscriptions' },
  { match: /^cookidoo/i,                         family: 'Subscriptions' },
  { match: /^patientfi/i,                        family: 'Subscriptions' },

  // Groceries
  { match: /^publix/i,                           family: 'Groceries' },
  { match: /trader joe/i,                        family: 'Groceries' },
  { match: /^whole foods/i,                      family: 'Groceries' },
  { match: /^casa martinez/i,                    family: 'Groceries' },

  // Parking (out-of-apt)
  { match: /(premium parking|laz parking|pay\s*by\s*phone|um parking)/i, family: 'Parking Afuera' },

  // Gas / fuel
  { match: /^(chevron|shell|exxon|bp|mobil|valero|sunoco|76|u-?gas)\b/i, family: 'Car' },

  // Bank / paycheck (Profit)
  { match: /heico corp/i,                        family: 'HEICO', force_type: 'Profit' },
  { match: /ticket\s*flipp|^lysted/i,            family: 'Ticket Flipping', force_type: 'Profit' },

  // Car
  { match: /kia motors finance|^kia finance|^kia lease/i, family: 'Car' },
  { match: /^geico/i,                            family: 'Car' },

  // Personal care
  { match: /yesstyle/i,                          family: 'Personal' },
  { match: /^pureology/i,                        family: 'Personal' },
  { match: /^sephora/i,                          family: 'Personal' },
  { match: /^ulta/i,                             family: 'Personal' },
  { match: /^forchics/i,                         family: 'Personal' },
  { match: /(corte de pelo|^barbero)/i,          family: 'Personal' },

  // Bank fees / Zelle payments → flag for review, default 'Other'
  { match: /monthly service fee/i,               family: 'Other' },
  { match: /^zelle payment to/i,                 family: 'Other' }, // outgoing Zelle, manual review
  { match: /^zelle payment from/i,               family: 'Other', force_type: 'Profit' },
];

// ─── classifier ──────────────────────────────────────────────────────────────
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function classify(t) {
  const merchRaw = t.merchant || '';
  const descRaw = t.description || '';
  const merchKey = norm(merchRaw);
  const descKey = norm(descRaw);

  for (const r of CUSTOM_RULES) {
    if (r.match.test(merchRaw) || r.match.test(descRaw)) {
      return { category: r.family, confidence: 0.9, source: `custom`, llc_category: r.llc, force_type: r.force_type };
    }
  }
  if (merchKey && categoriesConfig.merchant_rules[merchKey]) {
    const r = categoriesConfig.merchant_rules[merchKey];
    return { category: r.category, confidence: r.confidence, source: `exact` };
  }
  if (descKey && categoriesConfig.merchant_rules[descKey]) {
    const r = categoriesConfig.merchant_rules[descKey];
    return { category: r.category, confidence: r.confidence, source: `exact-desc` };
  }
  let best = null;
  for (const [key, rule] of Object.entries(categoriesConfig.merchant_rules)) {
    if (key.length < 4) continue;
    if (merchKey.includes(key) || descKey.includes(key)) {
      const score = rule.confidence * 0.85 * (key.length / Math.max(merchKey.length, descKey.length, 1));
      if (!best || score > best.score) best = { ...rule, score, key };
    }
  }
  if (best) return { category: best.category, confidence: Math.min(best.score, best.confidence), source: `partial` };

  if (t.apple_category) {
    const ac = t.apple_category.toLowerCase();
    if (ac.includes('grocer')) return { category: 'Groceries', confidence: 0.6, source: 'apple-hint' };
    if (ac.includes('restaurant') || ac.includes('food') || ac.includes('drink')) return { category: 'Take out/Uber Eats', confidence: 0.55, source: 'apple-hint' };
    if (ac.includes('gas') || ac.includes('automotive')) return { category: 'Car', confidence: 0.6, source: 'apple-hint' };
    if (ac.includes('travel')) return { category: 'Exceptions', confidence: 0.5, source: 'apple-hint' };
    if (ac.includes('shop')) return { category: 'Shopping', confidence: 0.5, source: 'apple-hint' };
    if (ac.includes('health') || ac.includes('beauty')) return { category: 'Personal', confidence: 0.55, source: 'apple-hint' };
    if (ac.includes('entertainment')) return { category: 'Exceptions', confidence: 0.5, source: 'apple-hint' };
  }
  if (t.plaid_pfc === 'FOOD_AND_DRINK') return { category: 'Take out/Uber Eats', confidence: 0.55, source: 'plaid-pfc' };
  if (t.plaid_pfc === 'TRANSPORTATION') return { category: 'Car', confidence: 0.55, source: 'plaid-pfc' };
  if (t.plaid_pfc === 'PERSONAL_CARE') return { category: 'Personal', confidence: 0.55, source: 'plaid-pfc' };
  if (t.plaid_pfc === 'HOME_IMPROVEMENT') return { category: 'Apartment', confidence: 0.55, source: 'plaid-pfc' };
  if (t.plaid_pfc === 'RENT_AND_UTILITIES') return { category: 'Apartment', confidence: 0.7, source: 'plaid-pfc' };
  if (t.plaid_pfc === 'TRAVEL') return { category: 'Exceptions', confidence: 0.55, source: 'plaid-pfc' };
  if (t.plaid_pfc === 'INCOME') {
    const d = norm(t.description);
    if (d.includes('heico')) return { category: 'HEICO', confidence: 0.85, source: 'plaid-pfc-income-heico' };
    if (d.includes('ticket') || d.includes('lysted')) return { category: 'Ticket Flipping', confidence: 0.8, source: 'plaid-pfc-income-tflip' };
    return { category: 'Other', confidence: 0.35, source: 'plaid-pfc-income-other' };
  }
  if (t.plaid_pfc === 'ENTERTAINMENT') return { category: 'Exceptions', confidence: 0.5, source: 'plaid-pfc' };

  return { category: 'Other', confidence: 0, source: 'fallback' };
}

// ─── normalize ───────────────────────────────────────────────────────────────
const normalized = [];

for (const tx of plaidTxns) {
  const acct = acctById[tx.account_id];
  if (!acct) { console.warn(`  UNMAPPED account_id ${tx.account_id} on tx "${tx.name}"`); continue; }
  if (shouldSkipPlaid(tx, acct, matchedTxIds)) continue;

  let txnType, costo;
  if (acct.subtype === 'credit card') {
    if (tx.amount > 0) { txnType = 'Expense'; costo = tx.amount; }
    else { txnType = 'Profit'; costo = -tx.amount; } // refund/credit on CC
  } else {
    if (tx.amount > 0) { txnType = 'Expense'; costo = tx.amount; }
    else { txnType = 'Profit'; costo = -tx.amount; }
  }

  normalized.push({
    source: 'plaid',
    date: tx.date,
    description: tx.name,
    merchant: tx.merchant_name || tx.name,
    amount: costo,
    type: txnType,
    plaid_pfc: tx.personal_finance_category?.primary,
    plaid_pfc_detail: tx.personal_finance_category?.detailed,
    pending: tx.pending,
    account: acct,
    raw: { name: tx.name, merchant_name: tx.merchant_name, transaction_id: tx.transaction_id },
  });
}

for (const r of appleRows) {
  const type = r['Type'];
  const amount = parseFloat(r['Amount (USD)']);
  if (type === 'Payment') continue;
  if (type === 'Debit' && /daily cash/i.test(r['Description'] || '')) continue;

  let txnType, costo;
  if (type === 'Purchase') {
    txnType = amount >= 0 ? 'Expense' : 'Profit';
    costo = Math.abs(amount);
  } else if (type === 'Credit') {
    txnType = 'Profit';
    costo = Math.abs(amount);
  } else {
    console.warn(`  Unknown Apple Type "${type}" on "${r['Merchant']}", skipping`);
    continue;
  }

  normalized.push({
    source: 'apple_csv',
    date: r._iso,
    description: r['Description'],
    merchant: r['Merchant'],
    amount: costo,
    type: txnType,
    apple_category: r['Category'],
    purchased_by: r['Purchased By'],
    account: appleAcct,
    raw: r,
  });
}

for (const t of normalized) {
  const c = classify(t);
  t.category = c.category;
  t.confidence = c.confidence;
  t.cls_source = c.source;
  t.llc_category_override = c.llc_category;
  if (c.force_type) t.type = c.force_type;
  t.needs_review = c.confidence < 0.5;
}

// Merge the synthetic savings-transfer rows (already classified)
for (const r of savingsSyntheticRows) normalized.push(r);

// Tax-accounting model: TF income and rent are recorded at FULL amount on family.
// The user's actual Marcus tax transfer is tracked as a separate Savings row above;
// the gap between (20% of TF) and the actual transfer is implicitly profit kept in
// checking. No pre-adjustment needed.
for (const t of normalized) t.family_amount = t.amount;

normalized.sort((a, b) => a.date.localeCompare(b.date));
console.log(`Normalized: ${normalized.length} transactions (incl. ${savingsSyntheticRows.length} synthetic savings rows)`);

// ─── row formatting ──────────────────────────────────────────────────────────
function familyDateSerial(iso) {
  // Sheets stores dates as serial numbers (days since 1899-12-30). The user's
  // existing data uses DATE format with pattern "d/M/yyyy" so the underlying must
  // be the correct serial; we then apply the same display pattern.
  const [y, m, d] = iso.split('-').map(Number);
  const epoch = Date.UTC(1899, 11, 30);
  const date = Date.UTC(y, m - 1, d);
  return Math.round((date - epoch) / 86400000);
}
function llcDate(iso)    { const [y, m, d] = iso.split('-'); return `${parseInt(m,10)}/${parseInt(d,10)}/${y}`; }
function dollar(n)       { return `$${n.toFixed(2)}`; }

function familyDesc(t) {
  if (t.merchant && t.merchant.length > 0 && t.merchant !== t.description) return t.merchant;
  return String(t.description).slice(0, 80);
}

function familyNote(t) {
  const parts = [];
  if (t._notes_extra) parts.push(t._notes_extra);
  if (t.needs_review) parts.push('⚠ review');
  if (t.purchased_by) parts.push(t.purchased_by.split(' ')[0]);
  if (t.pending) parts.push('pending');
  return parts.join(' | ');
}

const familyRows = normalized.map(t => [
  familyDesc(t),
  t.category,
  t.type,
  t.account.labels.family,
  t.family_amount,           // 80% for rent/TF, full otherwise
  familyDateSerial(t.date),
  familyNote(t),
]);

function familyToLlcCategory(t) {
  if (t.llc_category_override) return t.llc_category_override;
  const f = (t.category || '').toLowerCase();
  const d = String(t.description || '').toLowerCase();
  if (f === 'apartment' || /rent|fpl|electric|water|atnt|at&t|wifi|utilit/i.test(d)) return 'Home Office';
  if (f === 'subscriptions' || f === 'business q') return 'Subscriptions';
  if (f === 'phone') return 'Home Office';
  if (f === 'parking afuera' || /parking/i.test(d)) return 'Miscellaneous';
  if (f === 'exceptions') return 'Other';
  return 'Other';
}

// LLC template detection: which template pattern (if any) does this txn match?
const LLC_TEMPLATES = [
  { key: 'rent',        tx: /rent$|apartment rent|river landing.*rent/i,                  tmpl: new RegExp(`(?=.*${monthLong}|.*${monthShort}).*rent`, 'i') },
  { key: 'parking_apt', tx: /river landing parking/i,                                     tmpl: new RegExp(`(?=.*${monthLong}|.*${monthShort}).*parking(?! afuera)`, 'i') },
  { key: 'gpt',         tx: /^(openai|chatgpt|chat\s*gpt)/i,                              tmpl: new RegExp(`(?=.*${monthLong}|.*${monthShort}).*gpt`, 'i') },
  { key: 'cursor',      tx: /^cursor/i,                                                   tmpl: new RegExp(`(?=.*${monthLong}|.*${monthShort}).*cursor`, 'i') },
  { key: 'lovable',     tx: /^lovable/i,                                                  tmpl: new RegExp(`(?=.*${monthLong}|.*${monthShort}).*lovable`, 'i') },
  { key: 'atnt',        tx: /^at\s*&\s*t|^atnt/i,                                         tmpl: new RegExp(`(?=.*${monthLong}|.*${monthShort}).*at\\s*&?\\s*t`, 'i') },
  { key: 'utilities',   tx: /^fpl/i,                                                      tmpl: new RegExp(`office utilities\\s*${monthLong}|office utilities\\s*${monthShort}`, 'i') },
];

// Synthetic savings / tax-saving transfer rows are not real business purchases — keep
// them out of the LLC sheet even though tax-saving rows now carry type "Expense".
const businessTxns = normalized.filter(t =>
  t.account.is_business && t.type === 'Expense' &&
  t.source !== 'savings_pair' && t.source !== 'apple_savings_pattern'
);

// Build LLC operations: each is either "update template row N" or "append".
// Within one run, a given template (e.g. Lovable) can be filled at most once;
// additional matching txns fall through to APPEND.
const llcOps = [];
const claimedTemplates = new Set();
for (const t of businessTxns) {
  const descRaw = familyDesc(t);
  const tmplMatch = LLC_TEMPLATES.find(T => T.tx.test(descRaw) || T.tx.test(t.description || ''));
  const useTemplate = tmplMatch && !claimedTemplates.has(tmplMatch.key);
  if (useTemplate) claimedTemplates.add(tmplMatch.key);
  llcOps.push({
    txn: t,
    template_key: useTemplate ? tmplMatch.key : null,
    template_pattern: useTemplate ? tmplMatch.tmpl : null,
    appendRow: [
      llcDate(t.date),
      dollar(t.amount),
      `${monthLong} ${year} - ${descRaw}`,
      familyToLlcCategory(t),
      t.account.labels.llc,
    ],
  });
}

// ─── preview ─────────────────────────────────────────────────────────────────
function serialToDisplay(serial) {
  const epoch = Date.UTC(1899, 11, 30);
  const d = new Date(epoch + serial * 86400000);
  return `${d.getUTCDate()}/${d.getUTCMonth()+1}/${d.getUTCFullYear()}`;
}

console.log(`\n=== Family rows preview (${familyRows.length}, target "${familyTab}") ===`);
for (let i = 0; i < familyRows.length; i++) {
  const r = familyRows[i];
  const dateStr = serialToDisplay(r[5]);
  const amountStr = `$${Number(r[4]).toFixed(2)}`;
  console.log(`${String(i+1).padStart(3)}. ${dateStr.padStart(10)} ${amountStr.padStart(10)}  ${String(r[3]||'').padEnd(12)} ${r[2].padEnd(7)} ${String(r[1]).padEnd(22)} ${String(r[0]).slice(0,36).padEnd(36)} ${r[6]}`);
}

console.log(`\n=== LLC ops preview (${llcOps.length}) ===`);
for (let i = 0; i < llcOps.length; i++) {
  const op = llcOps[i];
  const tag = op.template_key ? `[TPL:${op.template_key}]` : '[APPEND]   ';
  const r = op.appendRow;
  console.log(`${String(i+1).padStart(3)}. ${tag} ${r[0].padStart(10)} ${r[1].padStart(10)}  ${r[4].padEnd(16)} ${r[3].padEnd(14)} ${String(r[2]).slice(0, 60)}`);
}

const reviewCount = normalized.filter(t => t.needs_review).length;
const byClsSource = {};
for (const t of normalized) byClsSource[t.cls_source] = (byClsSource[t.cls_source] || 0) + 1;

console.log(`\nStats: ${normalized.length} total | ${businessTxns.length} business | ${reviewCount} flagged ⚠ review`);
console.log(`Classifier sources:`, byClsSource);

if (!apply) {
  console.log(`\nDRY RUN. Re-run with --apply to write.`);
  process.exit(0);
}

// ─── apply ───────────────────────────────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const famMeta = await sheets.spreadsheets.get({ spreadsheetId: process.env.FAMILY_SHEET_ID });
const targetSheet = famMeta.data.sheets.find(s => s.properties.title === familyTab);
if (!targetSheet) {
  console.error(`Tab "${familyTab}" not found in family sheet`);
  process.exit(1);
}

// Read existing rows UNFORMATTED so we get native number types for dates / amounts.
console.log(`\nReading existing data in "${familyTab}"…`);
const existing = await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.FAMILY_SHEET_ID,
  range: `${familyTab}!A2:G200`,
  valueRenderOption: 'UNFORMATTED_VALUE',
});
const existingRows = (existing.data.values || [])
  .filter(r => r && r.slice(0, 7).some(c => c !== '' && c !== null && c !== undefined));

// Cards this script manages — we'll replace those rows but preserve user-typed rows on other cards.
const managedCards = new Set(
  accountsConfig.accounts.map(a => a.labels.family).filter(Boolean)
);
const userRows = existingRows.filter(r => r[3] && !managedCards.has(String(r[3])));
const myExistingCount = existingRows.length - userRows.length;
console.log(`Existing: ${existingRows.length} total | preserving ${userRows.length} on user-managed cards | replacing ${myExistingCount} on managed cards (${[...managedCards].join(', ')})`);

// Clear A2:G of whole working range
await sheets.spreadsheets.values.clear({
  spreadsheetId: process.env.FAMILY_SHEET_ID,
  range: `${familyTab}!A2:G300`,
});

const writeStartRow = 2;

// Build cellRows: user rows first (preserved) + my new rows. Convert each cell to
// an explicit userEnteredValue so Sheets doesn't reinterpret strings as dates.
function cellForFamilyValue(val, idx) {
  if (idx === 4) {
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/[$,]/g, ''));
    return {
      userEnteredValue: { numberValue: Number.isFinite(n) ? n : 0 },
      userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } },
    };
  }
  if (idx === 5) {
    let n;
    if (typeof val === 'number') n = val;
    else if (/^\d+\/\d+\/\d+$/.test(String(val))) {
      const [d, m, y] = String(val).split('/').map(Number);
      n = familyDateSerial(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    } else n = 0;
    return {
      userEnteredValue: { numberValue: n },
      userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'd/M/yyyy' } },
    };
  }
  if (val === null || val === undefined || val === '') return { userEnteredValue: { stringValue: '' } };
  if (typeof val === 'number') return { userEnteredValue: { numberValue: val } };
  return { userEnteredValue: { stringValue: String(val) } };
}

const allRowsCombined = [...userRows, ...familyRows]
  // Pad rows shorter than 7 columns
  .map(r => { const out = r.slice(0, 7); while (out.length < 7) out.push(''); return out; });

// Sort by date column (index 5). Both user rows (UNFORMATTED → number) and family
// rows (familyDateSerial → number) should be numbers here.
allRowsCombined.sort((a, b) => {
  const aD = typeof a[5] === 'number' ? a[5] : 0;
  const bD = typeof b[5] === 'number' ? b[5] : 0;
  return aD - bD;
});

const neededLastRow = writeStartRow - 1 + allRowsCombined.length;
const currentRowCount = targetSheet.properties.gridProperties.rowCount;
if (neededLastRow > currentRowCount) {
  const toAdd = neededLastRow - currentRowCount + 20;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.FAMILY_SHEET_ID,
    requestBody: {
      requests: [{
        appendDimension: { sheetId: targetSheet.properties.sheetId, dimension: 'ROWS', length: toAdd },
      }],
    },
  });
  console.log(`Expanded "${familyTab}" by ${toAdd} rows (was ${currentRowCount}, need ${neededLastRow}).`);
}

console.log(`Writing ${allRowsCombined.length} rows (${userRows.length} preserved + ${familyRows.length} new) to "${familyTab}" at A${writeStartRow}…`);
const cellRows = allRowsCombined.map(row => ({
  values: row.map(cellForFamilyValue),
}));

const batchResp = await sheets.spreadsheets.batchUpdate({
  spreadsheetId: process.env.FAMILY_SHEET_ID,
  requestBody: {
    requests: [{
      updateCells: {
        range: {
          sheetId: targetSheet.properties.sheetId,
          startRowIndex: writeStartRow - 1,
          endRowIndex: writeStartRow - 1 + cellRows.length,
          startColumnIndex: 0,
          endColumnIndex: 7,
        },
        rows: cellRows,
        fields: 'userEnteredValue,userEnteredFormat.numberFormat',
      },
    }],
  },
});
console.log(`  wrote ${cellRows.length} rows to "${familyTab}" (rows ${writeStartRow}–${writeStartRow + cellRows.length - 1})`);

if (familyOnly) {
  console.log('\n--family-only: skipping LLC sheet writes (LLC appends are not idempotent).');
  console.log('\nDone.');
  process.exit(0);
}

console.log(`\nProcessing ${llcOps.length} LLC ops…`);
const llcDescCol = (await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.LLC_SHEET_ID,
  range: `LLC Transactions!D:D`,
})).data.values || [];

const llcAppends = [];
let tmplFilled = 0;
const batchData = [];
const filledRows = new Set();
for (const op of llcOps) {
  if (op.template_key && op.template_pattern) {
    let rowIdx = null;
    for (let i = 0; i < llcDescCol.length; i++) {
      if (filledRows.has(i + 1)) continue;
      const cell = (llcDescCol[i][0] || '');
      if (op.template_pattern.test(cell)) { rowIdx = i + 1; break; }
    }
    if (rowIdx) {
      filledRows.add(rowIdx);
      batchData.push({ range: `LLC Transactions!B${rowIdx}`, values: [[op.appendRow[0]]] });
      batchData.push({ range: `LLC Transactions!C${rowIdx}`, values: [[op.appendRow[1]]] });
      batchData.push({ range: `LLC Transactions!F${rowIdx}`, values: [[op.appendRow[4]]] });
      tmplFilled++;
      console.log(`  TPL ${op.template_key} → row ${rowIdx} (${llcDescCol[rowIdx-1][0]})`);
      continue;
    }
  }
  llcAppends.push(op.appendRow);
}

if (batchData.length > 0) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.LLC_SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data: batchData },
  });
  console.log(`Filled ${tmplFilled} templated row(s) in LLC sheet.`);
}

if (llcAppends.length > 0) {
  const llcResp = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.LLC_SHEET_ID,
    range: `LLC Transactions!B:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: llcAppends },
  });
  console.log(`Appended ${llcAppends.length} non-template LLC row(s): ${llcResp.data.updates.updatedRange}`);
}

console.log('\nDone.');
