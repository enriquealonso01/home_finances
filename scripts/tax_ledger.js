// tax_ledger.js — shared lib for the LLC tax-categorization system (Phase 1).
// Two-layer categorizer per TAX-PLAN.md §3/§4:
//   layer 1 (existing): run_month.js CUSTOM_RULES + categories.json merchant_rules → internal category
//   layer 2 (this lib): internal category / merchant overrides → Schedule C line, type, bus_use, review
// Emits ledger rows keyed on Plaid transaction_id (idempotent upserts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

// ─── config ──────────────────────────────────────────────────────────────────
export const accountsConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/accounts.json'), 'utf-8'));
export const categoriesConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/categories.json'), 'utf-8'));
export const taxRules = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/tax_rules.json'), 'utf-8'));
export const acctById = Object.fromEntries(accountsConfig.accounts.map(a => [a.account_id, a]));

const KEY_FILE = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ? process.env.GOOGLE_APPLICATION_CREDENTIALS
  : path.join(ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS);

// ─── layer 1: merchant rules (mirrors run_month.js CUSTOM_RULES llc categories) ──
export const CUSTOM_RULES = [
  { match: /(openai|chatgpt|chat gpt)/i,         llc: 'Subscriptions' },
  { match: /^cursor( ai)?|cursor ai powered/i,   llc: 'Subscriptions' },
  { match: /^lovable/i,                          llc: 'Subscriptions' },
  { match: /^claude\.?ai|^anthropic/i,           llc: 'Subscriptions' },
  { match: /^vidu/i,                             llc: 'Subscriptions' },
  { match: /(^fal\b|fal features|fal\.ai)/i,     llc: 'Subscriptions' },
  { match: /(elevenlabs|11labs)/i,               llc: 'Subscriptions' },
  { match: /^kling/i,                            llc: 'Subscriptions' },
  { match: /^(runpod|runway)/i,                  llc: 'Subscriptions' },
  { match: /webshare/i,                          llc: 'Subscriptions' },
  { match: /plaid technologies/i,                llc: 'Subscriptions' },
  { match: /amazon web services|^aws$|aws bill/i,llc: 'Subscriptions' },
  { match: /(uploadpost|upload-?post|^upload$)/i,llc: 'Subscriptions' },
  { match: /thunder co/i,                        llc: 'Subscriptions' },
  { match: /text verified/i,                     llc: 'Subscriptions' },
  { match: /opus clip/i,                         llc: 'Subscriptions' },
  { match: /rendi\.dev/i,                        llc: 'Subscriptions' },
  { match: /^b66$|^b28 tx verify|^b83 tx verify|^c36 tx verify|^c6[19]$|^c9[23]$/i, llc: 'Subscriptions' },
  { match: /^netlify|^cloudflare|^submagic|^nodemaven|^moxee|^vacnu|^ipr$|^porkbun|^play$/i, llc: 'Subscriptions' },
  { match: /^microsoft|^google cloud|^shopify$/i,llc: 'Subscriptions' },
  { match: /spintax|sprintax|tax software|fiverr/i, llc: 'Subscriptions' },
  { match: /^autods/i,                           llc: 'Subscriptions' },
  { match: /^at\s*&\s*t|^at\.?nt/i,              llc: 'HomeOffice-Utilities-Phone' },
  { match: /^fpl$|florida power & light/i,       llc: 'HomeOffice-Utilities' },
  { match: /river landing parking|river landing - office parking|rl miami lp - office parking/i, llc: 'Parking' },
  { match: /(tello|moxee|nokia of america)/i,    llc: 'Internet & Phone' },
  { match: /(american airlines|delta|jetblue|spirit|frontier|united\b|hyatt|one11)/i, llc: 'Travel' },
  { match: /^turo/i,                             llc: 'Car & Transportation' },
  { match: /las vegas|aria patisserie|aria hotel|mandalay/i, llc: 'Travel' },
  { match: /^lyft\b/i,                           llc: 'Car & Transportation' },
  { match: /^uber\b(?!\s*\*?\s*eats)/i,          llc: 'Car & Transportation' },
  { match: /(premium parking|laz parking|pay\s*by\s*phone|um parking)/i, llc: 'Parking' },
  { match: /^(chevron|shell|exxon|bp|mobil|valero|sunoco|76|u-?gas)\b/i, llc: 'Car & Transportation' },
  { match: /^ticket\s*flipp|^lysted/i,           llc: 'Income-Ticketflipping', force_type: 'Income' },
  { match: /(monthly service fee)/i,             llc: 'Bank & Merchant Fees' },
  // income sources (§1.5 / §4.2) — custom rung, high confidence
  { match: /^zelle payment from ticket flipp/i,  llc: 'Income-Ticketflipping', force_type: 'Income' },
  { match: /krendora|orig co name:shopify|^shopify payout/i, llc: 'Income-Shopify', force_type: 'Income' },
  { match: /^facebook pay payroll/i,             llc: 'Income-Facebook', force_type: 'Income' },
  { match: /^facebook$/i,                        llc: 'Advertising' },
  // recurring merchants seen in 2026 Plaid data
  { match: /(7-eleven|shake shack|goldbelly|oceana grill|copper vine|ficelle|news cafe|mississippi)/i, llc: 'Meals (50%)' },
  { match: /^aliexpress/i,                       llc: 'Office Supplies' },
  { match: /^cloud$/i,                           llc: 'Subscriptions' },
  { match: /^plaid inc/i,                        llc: 'Subscriptions' },
  { match: /^apple$/i,                           llc: 'Subscriptions' },
  { match: /florida department of revenue/i,     llc: 'Taxes & Licenses' },
  { match: /^rl miami lp/i,                      llc: 'Parking' },
  { match: /^river landing/i,                    llc: 'HomeOffice-Rent' },
];

// merchant_rules keys in categories.json that mean these internal LLC categories
const EXACT_FAMILY_TO_LLC = {
  'subscriptions': 'Subscriptions',
  'car': 'Car & Transportation',
  'parking afuera': 'Parking',
  'exceptions': 'Travel',
  'apartment': 'HomeOffice-Utilities',
  'phone': 'Internet & Phone',
};

// ─── layer 2 core mapping (internal category → Schedule C) ───────────────────
const CM = taxRules.category_map;

// PFC fallbacks (ladder rung 4): Plaid personal_finance_category → internal category.
// Only used when rules layer 1 produced nothing — flags lower confidence.
const PFC_FALLBACK = {
  'RENT_AND_UTILITIES:RENT_AND_UTILITIES_RENT': 'HomeOffice-Rent',
  'FOOD_AND_DRINK': 'Meals (50%)',
  'TRAVEL': 'Travel',
  'TRANSPORTATION:TRANSPORTATION_TAXI': 'Car & Transportation',
  'TRANSPORTATION:TRANSPORTATION_OTHER': 'Car & Transportation',
};
function pfcToInternal(pfc, detailed) {
  const exact = PFC_FALLBACK[`${pfc}:${detailed}`];
  if (exact) return exact;
  if (PFC_FALLBACK[pfc]) return PFC_FALLBACK[pfc];
  if (pfc === 'INCOME') return 'Income-Other';
  if (pfc === 'GENERAL_SERVICES' || pfc === 'GENERAL_MERCHANDISE') return 'Subscriptions-Soft'; // service/software-ish spend on business card
  return null;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sheetCategoryToInternal(cat) {
  if (!cat) return null;
  const c = norm(cat);
  if (c.startsWith('home office - rent')) return 'HomeOffice-Rent';
  if (c.startsWith('home office - util')) return 'HomeOffice-Utilities';
  if (c.startsWith('internet & phone')) return 'Internet & Phone';
  if (c.startsWith('software & subsc') || c === 'subscriptions') return 'Subscriptions';
  if (c.startsWith('taxes & licenses')) return 'Taxes & Licenses';
  if (c.startsWith('car & transport')) return 'Car & Transportation';
  if (c.startsWith('travel')) return 'Travel';
  if (c.startsWith('meals')) return 'Meals (50%)';
  if (c.startsWith('advertising')) return 'Advertising';
  if (c.startsWith('bank & merchant')) return 'Bank & Merchant Fees';
  if (c.startsWith('office supplies')) return 'Office Supplies';
  if (c.startsWith('legal & professional')) return 'Legal & Professional';
  if (c.startsWith('repairs & maintenance')) return 'Repairs & Maintenance';
  if (c.startsWith('supplies')) return 'Supplies';
  if (c.startsWith('refund / credit')) return 'Refund / Credit';
  if (c.startsWith('needs review')) return null; // Needs-Review stays Needs-Review
  return null;
}

export function internalCategoryToTax(internal) {
  const m = taxRules.internal_category_to_sheet_category || {
    'HomeOffice-Rent': 'Home Office - Rent',
    'HomeOffice-Utilities': 'Home Office - Utilities',
    'HomeOffice-Utilities-Phone': 'Internet & Phone',
    'Parking': 'Car & Transportation',
    'Subscriptions': 'Software & Subscriptions',
  };
  return m[internal] || internal || null;
}

// Layer 1 classifier (mirrors run_month.js ladder, LLC-focused)
export function classifyInternal(descRaw, merchantRaw, pfc, pfcDetailed) {
  for (const r of CUSTOM_RULES) {
    if (r.match.test(descRaw) || r.match.test(merchantRaw || '')) {
      return { internal: r.llc, force_type: r.force_type || null, source: 'custom-rule' };
    }
  }
  const keys = [norm(merchantRaw), norm(descRaw)].filter(Boolean);
  for (const k of keys) {
    if (categoriesConfig.merchant_rules[k]) {
      const fam = categoriesConfig.merchant_rules[k].category;
      const mapped = EXACT_FAMILY_TO_LLC[String(fam).toLowerCase()] || null;
      if (mapped) return { internal: mapped, source: 'exact-merchant' };
    }
  }
  // Plaid PFC fallback — soft/internal only; still needs a merchant rule eventually.
  const viaPfc = pfcToInternal(pfc, pfcDetailed);
  if (viaPfc) return { internal: viaPfc, source: 'plaid-pfc' };
  return { internal: null, source: 'unmatched' };
}

// Layer 2: given internal category + merchant/desc + amount sign → tax row fields
// in = { internal, sheetCategory, merchant, description, isIncome }
export function applyTaxRules({ internal, sheetCategory, merchant, description }) {
  const descAll = `${merchant || ''} ${description || ''}`;
  const cat = internal || sheetCategoryToInternal(sheetCategory);

  // Personal-spend flagging (§7.4): merchants that on a business card mean personal use.
  const PERSONAL_RE = /(sephora|ulta\b|total wine|seatgeek|mancave for men|cmx cinemas|costco|publix|trader joe|whole foods|walmart|target|amazon prime video)/i;
  if (PERSONAL_RE.test(descAll) && taxRules.merchant_overrides) {
    // fall through to normal categorization BUT mark personal below via bus_use override
  }
  const isPersonalSpend = PERSONAL_RE.test(descAll);

  // merchant overrides (AutoDS COGS-vs-SaaS, refunds, personal flags)
  for (const o of taxRules.merchant_overrides) {
    const re = new RegExp(o.match, 'i');
    if (!re.test(descAll) && !re.test(merchant || '')) continue;
    if (o.any_category || cat === 'Subscriptions' || !cat) {
      if (o.subscription_hint && !new RegExp(o.subscription_hint, 'i').test(descAll)) {
        return { ...o.default, category: cat || 'Software & Subscriptions' };
      }
      if (o.subscription_hint) {
        return { ...o.expense, category: 'Software & Subscriptions' };
      }
      return { ...o.default, category: cat || 'Needs Review' };
    }
  }

  const direct = internal ? internalCategoryToTax(internal) : null;
  const key = direct || sheetCategory || (internal === 'Subscriptions' ? 'Software & Subscriptions' : null);
  const mapped = key ? CM[key] : null;

  if (mapped && mapped.review) {
    return { review: true, category: sheetCategory || 'Needs Review', type: 'Expense', bus_use: 'mixed-review' };
  }
  if (mapped && mapped.line) {
    return { line: mapped.line, turbotax: mapped.turbotax, part_v: mapped.part_v || '', type: mapped.type,
             bus_use: isPersonalSpend ? 'personal' : mapped.bus_use, pct: mapped.pct, category: key, estimate: mapped.estimate || false,
             review: isPersonalSpend ? true : undefined };
  }
  if (cat) {
    const viaCat = CM[cat];
    if (viaCat && viaCat.line) {
      return { line: viaCat.line, turbotax: viaCat.turbotax, part_v: viaCat.part_v || '', type: viaCat.type,
               bus_use: isPersonalSpend ? 'personal' : viaCat.bus_use, pct: viaCat.pct, category: cat, estimate: false,
               review: isPersonalSpend ? true : undefined };
    }
  }
  if (internal === 'Subscriptions-Soft') {
    // PFC-only guess: business-card service spend → 27a software subs, flagged review
    return { line: '27a', turbotax: 'Other expenses', part_v: 'Software subscriptions', type: 'Expense',
             bus_use: 'mixed-review', pct: 100, category: 'Software & Subscriptions', review: true };
  }
  if (internal === 'Income-Other') {
    return { line: 'P1', turbotax: 'Gross receipts / sales', type: 'Income', bus_use: 'business',
             category: 'Needs Review', review: true };
  }
  const d = taxRules.defaults.unmapped_category;
  return { review: true, category: sheetCategory || 'Needs Review', type: d.type, bus_use: d.bus_use };
}

// ─── Plaid pull ──────────────────────────────────────────────────────────────
function plaidClient() {
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET } },
  }));
}

export async function pullPlaidTransactions(startDate, endDate, { businessOnly = true } = {}) {
  const TOKENS_FILE = path.join(ROOT, 'secrets/plaid_tokens.json');
  const tokens = fs.existsSync(TOKENS_FILE) ? JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')) : {};
  const plaid = plaidClient();
  const out = [];
  const errors = [];
  for (const [item_id, t] of Object.entries(tokens)) {
    let offset = 0; const count = 500;
    let pulled = 0;
    while (true) {
      let resp;
      try {
        resp = await plaid.transactionsGet({
          access_token: t.access_token,
          start_date: startDate,
          end_date: endDate,
          options: { offset, count },
        });
      } catch (e) {
        const code = e?.response?.data?.error_code || e?.code || 'UNKNOWN';
        errors.push({ item_id, error_code: code });
        console.warn(`  Plaid item ${item_id} FAILED (${code}) — skipping; its transactions are NOT included.`);
        break;
      }
      out.push(...resp.data.transactions);
      pulled += resp.data.transactions.length;
      if (resp.data.transactions.length < count) break;
      offset += count;
      if (offset >= resp.data.total_transactions) break;
    }
    if (pulled > 0) console.log(`  item ${item_id}: ${pulled} transactions`);
  }
  if (errors.length > 0) console.warn(`Plaid items with errors: ${errors.map(e => `${e.item_id.slice(0, 8)}…=${e.error_code}`).join(', ')}`);
  return businessOnly ? out.filter(tx => acctById[tx.account_id]?.is_business) : out;
}

const SKIP_NAME = [
  /online transfer/i, /^payment to (chase|apple|discover|amex|capital one|amer)/i,
  /^apple card$/i, /apple gs savings/i, /discover e-payment/i,
  /jpmorgan chase ext trnsfr/i, /atm withdrawal/i, /atm fee/i,
  /^interest paid$/i, /^interest earned$/i, /internet transfer/i, /^ett$/i, /^deposit$/i,
  /autods balance/i,
];

export function shouldSkipPlaid(tx) {
  const acct = acctById[tx.account_id];
  if (!acct || acct.subtype === 'savings') return true;
  const name = String(tx.name || '');
  for (const p of SKIP_NAME) if (p.test(name)) return true;
  const pfc = tx.personal_finance_category?.primary;
  const pfcd = tx.personal_finance_category?.detailed || '';
  if (pfc === 'TRANSFER_IN' || pfc === 'TRANSFER_OUT') return true;
  if (pfc === 'LOAN_PAYMENTS' && /CREDIT_CARD/.test(pfcd)) return true;
  return false;
}

// ─── ledger row builder ──────────────────────────────────────────────────────
export function llcDate(iso) {
  const [, m, d] = iso.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${iso.slice(0, 4)}`;
}

export function buildLedgerRow(tx) {
  const acct = acctById[tx.account_id];
  const merchant = tx.merchant_name || tx.name;
  const description = tx.name;
  const isIncome = tx.amount < 0; // Plaid: negative = money in
  let amount, type;
  if (isIncome) { amount = -tx.amount; type = 'Income'; }
  else { amount = tx.amount; type = 'Expense'; }

  const internal = classifyInternal(description, merchant,
    tx.personal_finance_category?.primary, tx.personal_finance_category?.detailed);
  if (internal.force_type) type = internal.force_type;

  const tax = applyTaxRules({
    internal: internal.internal,
    sheetCategory: null,
    merchant,
    description,
  });
  if (tax.line === 'P1' || /income/i.test(internal.internal || '')) type = 'Income';
  if (internal.source === 'plaid-pfc' && !tax.review) tax.review = true; // PFC rung always soft

  const needsReview = !!tax.review || internal.source === 'unmatched';
  return {
    key: tx.transaction_id,
    date: tx.date,
    amount,
    description,
    category: tax.category || 'Needs Review',
    card: acct.labels.llc || acct.plaid_name,
    type,
    scline: tax.line || '',
    turbotax: tax.turbotax || '',
    bus_use: tax.bus_use || 'mixed-review',
    pct: tax.pct ?? '',
    review: needsReview ? 'Y' : '',
    notes: [tax.part_v ? `Part V: ${tax.part_v}` : '', tax.estimate ? 'estimate' : '',
            internal.source === 'plaid-pfc' ? 'pfc-only' : '', tx.pending ? 'pending' : '']
      .filter(Boolean).join('; '),
  };
}

// ─── Google Sheets helpers ───────────────────────────────────────────────────
export async function sheetsClient() {
  const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

export function dateToSerial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((Date.UTC(y, m - 1, d) - epoch) / 86400000);
}

// Existing "LLC Transactions" tax-column signature (columns K..S), keyed on row number
export async function readExistingTaxIndex(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.LLC_SHEET_ID,
    range: `LLC Transactions!K2:S1376`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const idx = new Map();
  (res.data.values || []).forEach((row, i) => {
    const key = row[9]; // column T = plaid tx id
    if (key) idx.set(String(key), i + 2);
  });
  return idx;
}

export function makeSheetRow(r) {
  return [
    r.date, r.amount, r.description, r.category, r.card,
    r.type, r.scline, r.turbotax, r.bus_use, r.pct, r.review, r.notes, r.key,
  ];
}
