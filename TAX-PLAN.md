# PSConsulting LLC — Tax-Categorization System Plan

**Status:** PLAN ONLY — no accounts connected, no sheets modified, no money spent.
**Prepared:** 2026-09-11 · Owner: Enrique · Entity: Proven & Solved LLC (PSConsulting), Miami FL — assumed single-member LLC taxed as sole proprietorship (Schedule C) *unless Enrique says otherwise (see Open Questions)*.
**No transaction amounts appear in this document** (financial-data hygiene rule).

---

## 1. Goal (Enrique's requirements, restated)

1. A weekly agent categorizes the prior week's transactions into **IRS/TurboTax Schedule C categories**.
2. **COGS** (e.g., AutoDS fulfillment cost for Krendora) must **reduce taxable profit**: taxable = Revenue − COGS, not revenue-taxed.
3. **Personal-card business expenses** (rent share, parking, home-office utilities, AT&T) must be captured even though they never touch a business account.
4. **Business-card personal purchases** must be flagged and excluded from Schedule C (mixed-use card problem).
5. Income side captured: Ticketflipping payouts, Facebook payouts, Shopify payouts (Shopify finances connection is approved).
6. Deliverable: **year-end TurboTax-ready report** — per-Schedule-C-line totals he can type straight into TurboTax, plus quarterly check-in reports for estimated-tax sanity.

---

## 2. Current state (verified on-box)

### 2.1 What already exists in `/root/projects/home_finances`

| Piece | Status |
|---|---|
| Plaid Chase item | ✅ Connected. Covers **BUS COMPLETE CHK ****2502** (`is_business: true`, llc label `P&S CHK 2502`) and **E. ALONSO ****5441** Chase Ink card (`is_business: true`, `P&S Credit 5441`). |
| Categorizer | ✅ Exists in `scripts/run_month.js`: `CUSTOM_RULES` regex list (with dual `family` + `llc` categories) → `config/categories.json` `merchant_rules` (180 rules) → Plaid `personal_finance_category` fallbacks. |
| LLC categories already in use by rules | `Subscriptions`, `Home Office`, `Miscellaneous`, `Other` — these match the LLC sheet tabs' vocabulary (`Home Office - Rent`, `Software & Subscriptions`, `Taxes & Licenses`, `Car & Transportation`) loosely but **not exactly** — mapping needed (§4). |
| LLC Sheets | `LLC_SHEET_ID` with `Summary`, `LLC Transactions` (Date, Amount, Description, Category, Card Used), `TAX borrowing`. A **2025 version of the same sheet** exists on the same Google account (findable via Drive search — Phase 1 backfill task). |
| Family sheet | RETIRED as a data destination (superseded by home-budget/Supabase) but `config/categories.json` — trained on it — **remains the living merchant-rules source**. Keep it read-only as a rules input. |
| Marcus "2026 LLC Taxes" savings | Already special-cased in `run_month.js` as `Tax Saving` — good; feeds the `TAX borrowing` tab concept, not Schedule C. |

### 2.2 Gaps

- ❌ No Citibank business card connection.
- ❌ No personal checking connection (apartment rent + parking + home-office utilities are paid from it — currently invisible to the LLC ledger).
- ❌ No Shopify payouts source.
- ❌ No explicit **COGS** category anywhere (AutoDS is currently classified as `Subscriptions` — wrong for tax purposes; see §5).
- ❌ No business-income categorization beyond Ticketflipping (`force_type: 'Profit'`); Facebook payouts unhandled.
- ❌ No weekly cadence (current script is monthly) and no Schedule C rollup/report.
- ⚠️ Chase Ink ****5441 carries some personal spend → needs a personal/business flag per transaction, not per account.

---

## 3. Target architecture

```
SOURCES                      CATEGORIZER                 LLC LEDGER (Google Sheet)         REPORTS
─────────────────────        ───────────────────         ──────────────────────────        ─────────────────
Plaid: Chase item            scripts/tax_weekly.js       tab: LLC Transactions             Quarterly report tab
  ├ BUS CHK ****2502    ──►  (new weekly variant of      (existing cols + new:             (Q1–Q4: per-line totals,
  └ E. ALONSO ****5441  ──►   run_month.js:                 ScheduleC Line,                 est. tax checkpoint)
Plaid: Citi item (new)  ──►   rules engine reused,          COGS flag,                      Year-end report tab
Plaid: Personal chk(NEW)──►   output = Schedule C)          Income/Expense/COGS,            "Type into TurboTax"
Plaid/CSV: Shopify       ──►                              Personal-Use flag,             sheet: every Schedule C
  payouts (§6.3)                                            Needs-Review flag)             line → dollar total,
Manual: AutoDS order       Rules sources:                   tab: COGS Log (detail)         quarterly summary,
  cost report (§5.3)        config/categories.json          tab: Income by Source          plus YTD.
                            (kept as-is) +
                            config/tax_rules.json
                            (new, Schedule C layer)
```

Design principles:

1. **One rules engine, two layers.** Keep `merchant_rules`/`CUSTOM_RULES` as layer 1 (merchant → internal category). Add layer 2: `internal category → Schedule C line` mapping table (`config/tax_rules.json`). Never retrain layer 1 for tax reasons.
2. **Ledger rows are immutable + append-only.** Weekly agent appends; corrections are new rows with a `supersedes` note, never edits — preserves audit trail.
3. **Account context ≠ tax treatment.** Business account ≠ business expense. Every row gets an explicit `bus_use` verdict: `business` / `personal` / `mixed-review`. Personal checking rows enter the ledger **only** when classified as business-use (rent %, parking, utilities %, AT&T %) — the rest of personal-checking activity never leaves the family side.
4. **COGS is a first-class type**, not an expense category: `type ∈ {Income, Expense, COGS, Transfer, TaxSetAside}`.
5. **TurboTax report is a pure projection** of the ledger — regenerated on demand, never hand-edited.

---

## 4. IRS Schedule C category mapping (the core table)

Researched against Schedule C (Form 1040) Part II/III and TurboTax's category list (2025–2026 forms; verify line numbers against the filed-year form each January — IRS occasionally renumbers).

### 4.1 Part II — Expenses

| Schedule C line | Category | What goes in it (Enrique's merchants) | Maps from existing internal categories |
|---|---|---|---|
| 8 | **Advertising** | FB/Meta ads, Google Ads, boosted posts, IG promos, marketing tools | new `Advertising` |
| 9 | **Car and truck expenses** | Business-mileage log (standard mileage, ~$0.70/mi for 2025 — confirm filed-year rate) **or** actual method (gas, lease, insurance × business %). Parking for business trips here or Line 27a — decide once (§8 Q6) | `Car & Transportation` (business share) |
| 10 | **Commissions and fees** | Platform/marketplace fees: Shopify Payments fees, Ticketflipping platform fees, Stripe/PayPal fees, seller fees | new `Platform Fees` |
| 11 | **Contract labor** | 1099 work for the LLC (e.g., freelance edits); **1099-NEC required ≥ $600/yr per person** | new `Contract Labor` |
| 12 | Depletion | n/a — leave unused | — |
| 13 | **Depreciation / §179** | Laptop, camera, gear over de-minimis ($2,500/item threshold election) — likely small; track candidates in ledger, let CPA decide | new `Equipment` (candidate-only) |
| 14 | Employee benefits | n/a (no W-2 employees) | — |
| 15 | **Insurance** | Business insurance (lease/liability/E&O). Note: the car lease insurance Enrique pays is *vehicle* insurance → Line 9, not here | `lease insurance` rows currently `Miscellaneous` |
| 16 | **Interest** | Business credit-card interest (Chase Ink), business loan interest | new `Interest` |
| 17 | **Legal and professional** | CPA/tax-prep fees, legal, registered agent, business consultants | new `Professional Fees` |
| 18 | **Office expense** | Office supplies, postage, small consumables | new `Office Expense` |
| 19 | Pension/profit-sharing | n/a | — |
| 20a/b | **Rent or lease** — *see home-office note* | Only for rented business property **other than** the home office. Enrique's apartment rent is claimed via **Line 30 home office**, NOT Line 20 — do not double-count | — |
| 21 | Repairs and maintenance | n/a likely | — |
| 22 | **Supplies** | Taxable supplies used in the business — for Krendora, shipping/packaging supplies (non-COGS side) | new `Supplies` |
| 23 | **Taxes and licenses** | FL LLC annual report fee, Sunbiz, sales-tax permits/licenses, business licenses. **Not** income tax itself | `Taxes & Licenses` ✅ direct match |
| 24a | **Travel** | Flights, hotels, rental cars for business trips (Vegas ticket trips → review business %) | `Exceptions` rows with travel merchants |
| 24b | **Deductible meals** | Business meals — **50% only**; entertainment 0%. Ledger stores full amount + `pct_deductible: 50`; report applies the % | new `Meals (Business)` |
| 25 | **Utilities** | Business-phone + internet **business-use %**. Home electricity/gas → home office (Line 30) instead. AT&T cell → Line 25 at business-use % (Enrique states the % — §8 Q4) | `AT&T` rule currently → `Home Office`; move to Line 25 |
| 26 | Wages | n/a | — |
| 27a | **Other expenses** (itemized Part V) | Catch-all with names: "Software subscriptions", "Bank fees", "Merchant fees" if not on Line 10, "Parking", "Education/training" | `Miscellaneous`, `Subscriptions` |
| 27b–29 | Totals | computed | — |
| 30 | **Home office (Form 8829 or simplified)** | **Simplified:** $5/sq ft × up to 300 sq ft, max $1,500, no Form 8829. **Actual:** (office sq ft ÷ home sq ft) × rent + utilities + renter's insurance. Rent + FPL currently tagged `Home Office` → this line. Requires regular & exclusive use. §8 Q3 = which method | `Home Office - Rent`, `Home Office` |

TurboTax behavior note: TurboTax walks through these same buckets with friendlier names ("Advertising", "Car expenses", "Contract labor", "Office expenses", "Supplies", "Legal/professional", "Utilities", "Travel", "Other", plus a dedicated home-office interview). The report tab should use the official line numbers with TurboTax interview names in a second column so Enrique can match them on screen.

### 4.2 Part III — COGS (Krendora / AutoDS) and Part I — Income

| Schedule C line | What goes in it |
|---|---|
| Part I, Line 1 **Gross receipts** | All payouts: Ticketflipping, Facebook, Shopify **gross sales** (not net deposits — see §5.2), client revenue. Refunds/returns net in here per instructions to Line 2. |
| Line 35/38 **Purchases** | Product cost: AutoDS fulfillment charges for goods sold (dropshipping: purchases flow straight to COGS via Lines 38/39/40/42; minimal inventory is held) |
| Lines 39–42 | Materials/supplies, other costs, ending inventory — for pure dropshipping, inventory at year end ≈ $0, so COGS ≈ purchases + shipping to customer |
| Line 4 **COGS** | Subtract on Line 4; taxable profit = Line 1 − Line 4 − Part II total. This is the "COGS reduces taxable profit" requirement. |

### 4.3 Existing internal → Schedule C mapping table (`config/tax_rules.json` seed)

| Internal (ledger) | → Schedule C line |
|---|---|
| `Software & Subscriptions` / `Subscriptions` (business) | 27a "Software subscriptions" |
| `Home Office - Rent` / `Home Office` (FPL, rent share) | 30 (form 8829 or simplified) |
| `Taxes & Licenses` | 23 |
| `Car & Transportation` (business share) | 9 (+ mileage log) |
| `Advertising` (new) | 8 |
| `Platform Fees` (new: Shopify/Ticketflipping/FB fees) | 10 |
| `Contract Labor` (new) | 11 |
| `Insurance` (business liability/lease) | 15 |
| `AT&T` business % | 25 |
| `Travel` business | 24a |
| Business meals | 24b (50%) |
| `Equipment` (new) | 13 (pending CPA) |
| `Miscellaneous` (business) | 27a Part V itemized |
| AutoDS fulfillment charges | **COGS** (Part III Line 38) — *reclassify from `Subscriptions`* |
| Interest on Ink card | 16 |
| `Tax Saving` / `TAX borrowing` / transfers | **not on Schedule C** — report-only memo |

---

## 5. COGS vs expense handling (e-commerce)

### 5.1 The rule
- **COGS** = cost of the *goods themselves* sold to customers (AutoDS fulfillment charges = supplier + shipping for Krendora orders). Reduces gross receipts dollar-for-dollar **before** expenses — exactly Enrique's requirement.
- **Expense** = cost of running the business (AutoDS *subscription fee* is an expense, Line 27a — only the per-order fulfillment charges are COGS; don't lump the SaaS fee into COGS).
- Shopify's own guidance: payment-processing fees are commonly tracked with COGS/margin; on Schedule C they can go on **Line 10 (commissions & fees)** — cleaner and TurboTax-friendly. Pick Line 10 and be consistent.

### 5.2 Shopify payouts — gross vs net (critical)
Shopify pays **net** (gross sales − processing fees − refunds − chargebacks − holds). If the ledger books only the net deposit as income, revenue is understated and fees never get deducted. The weekly agent must therefore:
1. Pull Shopify payout **detail** (each payout's breakdown), not just the bank deposit line.
2. Book: gross sales → Income (Line 1); fees → Line 10; refunds → contra-income; sales tax collected → excluded from income (it's trust money).
3. Reconcile: gross − refunds − fees = payout deposit hitting the bank. Mismatch ⇒ `Needs-Review`.
4. If the Shopify API route isn't used, fall back to monthly **Payouts/Transactions CSV export** (Shopify admin) ingested like the Apple Card CSVs already are.

### 5.3 AutoDS data source
Plaid sees AutoDS card charges (subscription) but not per-order costs. Options: (a) AutoDS CSV/report export (order-level cost), (b) treat AutoDS card charges as COGS when merchant descriptor includes order refs. Phase 1 can approximate with card charges; Phase 2/3 refines with exports. Flag as estimate until Enrique confirms which report he can get (§8 Q7).

### 5.4 Ledger representation
`COGS Log` tab: date, order ref, supplier (AutoDS), goods cost, shipping, store (Krendora), linked payout. Weekly rollup adds to `LLC Transactions` as one `type: COGS` row per store-day (detail kept in COGS Log).

---

## 6. Account-connection plan

### 6.1 Already live — no action
- Chase business checking ****2502 + Chase Ink ****5441 (existing Plaid item).
- Plaid pulls run every ~5h via existing `mcps/plaid` + tokens in `plaid_tokens.json`.

### 6.2 To add — Plaid items
| Priority | Connection | How | Why |
|---|---|---|---|
| 1 | **Personal checking** (the account apartment rent + parking + FPL + AT&T flow from) | New Plaid Link item, same public-token flow as Chase; add to `config/accounts.json` with `is_business: false` + `llc_use: 'home-office-source'` | Captures the personal-card/home-office business expenses (requirement #3). The ledger only ingests the business-use subset — never the whole personal account. |
| 2 | **Citibank business card** | New Plaid item (Citi is Plaid-supported; if the specific card isn't, fall back to monthly statement CSV, same as Apple Card flow) | Main gap in business-card coverage; needs the personal-purchase flagging flow of §7.4. |
| 3 | **Shopify payouts** | Preferred: **Shopify Admin API** (`shopify_payouts`/Finances) with a custom-app token — needs a payout *bank account* visible in Plaid to reconcile, which exists once it pays to ****2502 or Citi. Fallback: monthly payouts CSV export | Income completeness (requirement #5). |

### 6.3 Sequencing & safety
- All connections gated on Enrique's explicit go (live bank access = gated per skill rules). No Plaid spend; Link flow is what costs nothing (Plan-tier per-item considerations noted: verify current Plaid pricing tier before adding items — §8 Q8).
- Personal-checking ingestion must be **filter-first**: only rows matching home-office merchant rules ever enter the LLC ledger. Everything else stays family-side (home-budget app).
- After each new item: extend `config/accounts.json` (institution, mask, `is_business`, `llc` label, notes) exactly like existing entries; run `verify_sheets.js`/`test_mcp_plaid.js` read-only checks.

---

## 7. Weekly cron agent — data flow

### 7.1 Schedule
Cron (Hermes cronjob, e.g. **Monday 07:00 ET**, covering Mon–Sun prior week) runs `node scripts/tax_weekly.js --week prev` plus, on failure, a Hermes-agent retry with reporting. Monthly: full-month reconciliation pass; Quarterly: report generation + estimated-tax checkpoint.

### 7.2 Pipeline steps (per week)
1. **Pull** — Plaid `/transactions` for business accounts + personal-checking (filtered) for the window; Shopify payouts via API/CSV.
2. **Normalize** — into the existing row shape (Date, Amount, Description, Card Used) + new cols (`Type`, `ScheduleC Line`, `BusUse`, `Pct`, `Review`).
3. **Classify** — two-layer engine (§3). Confidence ladder: exact merchant rule → CUSTOM_RULES regex → tax_rules mapping → Plaid PFC → `Needs-Review`.
4. **Business/personal verdicts** — see §7.4.
5. **COGS sync** — ingest AutoDS order costs; append COGS rows (§5.4).
6. **Append** — new rows to `LLC Transactions`; recompute `Summary` (income by source, YTD per line); update `COGS Log`.
7. **Report** — regenerate quarterly/year-end projection tabs.
8. **Notify** — WhatsApp/email digest to Enrique: counts, new Needs-Review items, mismatches. **No amounts in the notification body** (sensitive-data rule) — just counts + link.

### 7.3 Idempotency
Key rows on `date|account_mask|amount-cents|merchant-hash` (Plaid `transaction_id` preferred). Re-runs upsert, never duplicate. Weekly state in `data/weekly_state.json` (gitignored).

### 7.4 Personal-vs-business flagging rules
- **Personal card → business expense (capture):** rent-share, parking (river landing/premium/laz), FPL, AT&T — via explicit allowlist rules tagged `llc_use`. Each carries a `pct` (Enrique-stated business-use %; rent/FPL default from home-office sq-ft ratio, §8 Q3/Q4).
- **Business card → personal purchase (exclude):** default verdict for Ink ****5441 rows is `business`; personal merchants (groceries, Sephora/Ultata-class, personal subscriptions — reuse family `merchant_rules` categories) flip to `personal`, row stays in ledger with `BusUse: personal`, **excluded** from Schedule C totals but visible for the yearly accountability review.
- **Ambiguous** (Target, Amazon, Walmart-class multi-use merchants): `mixed-review` → weekly digest asks Enrique one-tap verdicts; his answers write back as new high-confidence rules (this is how the rules engine improves itself).

### 7.5 Failure modes handled
- Plaid item break (re-auth needed) → agent stops, notifies, never writes partial weeks.
- Duplicate payouts (Shopify retry) → idempotency key.
- Sheet write failure → buffer to `data/pending_writes.json`, retry next run.

---

## 8. Open questions for Enrique

1. **Entity tax classification:** confirmed single-member LLC (disregarded → Schedule C), or has he elected S-corp? (S-corp changes everything: payroll, 1120-S, no Schedule C.)
2. **Revenue mix:** roughly which businesses generate what (Ticketflipping, Facebook payouts, Krendora/Shopify, consulting) — needed for `Income by Source` tab and 1099-K cross-checks.
3. **Home-office method:** simplified ($5/sq ft, max $1,500) vs actual (rent + utilities × business %)? Actual usually wins for renters with a decent office % — but that's a CPA/Enrique call. Need: office sq ft + apartment sq ft.
4. **Business-use percentages:** AT&T cell %, internet %, and confirmation that parking (River Landing etc.) is business parking.
5. **Facebook payouts:** from what (page monetization/ads rebates?) and to which account do they land today?
6. **Car:** standard mileage or actual? If standard, we need a mileage log habit (agent can prompt weekly: "business miles last week?"). Are business-trip parking costs Line 9 or 27a (pick one)?
7. **AutoDS:** can he export an order-level cost report (CSV/API)? What exactly does Krendora's per-order COGS include (goods + shipping)?
8. **Plaid tier/pricing:** confirm current per-item cost before adding Citi + personal checking.
9. **2025 sheet:** confirm we should also produce a 2025 TurboTax report from the 2025 LLC sheet (same pipeline, backfill mode) or 2025 is CPA-handled/done.
10. **Citi card ownership:** is the Citi card titled to the LLC (business credit line) — affects whether its interest goes on Line 16 and how he reports it.
11. **Estimated taxes:** does he pay quarterly estimates today, and does he want the Q-reports to compute a suggested set-aside % into the Marcus "LLC Taxes" bucket?

---

## 9. Phased rollout

### Phase 1 — Backfill 2026 YTD from what already exists (no new connections)
1. Find the 2025 LLC sheet via Drive (read-only) — confirms tab/column conventions + closing balances carried into 2026.
2. Extend `config/tax_rules.json` (new file, §4.3 mapping) — no changes to existing categories.json behavior.
3. Build `scripts/tax_ledger.js` (shared lib: classify → verdict → ledger row) + `scripts/tax_weekly.js` (windowed runner, idempotent).
4. Backfill: replay all 2026 Chase-business transactions through the engine → append to `LLC Transactions` with Schedule C columns. Leave existing family pipeline untouched.
5. Manually-enter rows for known personal-card business items (rent share, parking, FPL, AT&T) from personal records until the personal checking item is connected — Enrique reviews the allowlist before anything is booked.
6. Seed `COGS Log` from AutoDS card charges 2026 YTD (flagged *estimate*).
7. Generate the **first year-end projection** + Q1–Q3 (as of now) summary; Enrique sanity-checks against intuition before trusting the system.
8. Weekly digest starts (cron), reporting only Needs-Review queue.

### Phase 2 — New connections (each behind Enrique's explicit go)
1. Personal checking Plaid item → home-office expense capture goes automatic.
2. Citibank business card item (or statement-CSV fallback) → personal-purchase flagging flow live.
3. Shopify: API token or CSV export → gross-to-net payout reconciliation (§5.2).
4. Re-run backfill including new sources for full-2026 coverage; close remaining Needs-Review queue with Enrique in one sitting.

### Phase 3 — Steady state + reporting
1. Weekly agent (§7) fully autonomous: pull → classify → append → report → digest.
2. Quarterly reports + estimated-tax checkpoint (Q1 Apr 15, Q2 Jun 15, Q3 Sep 15, Q4 Jan 15 — confirm dates each year).
3. **Year-end TurboTax-ready report** tab: one row per Schedule C line (line #, TurboTax interview name, annual total, deductible % applied, supporting-tab link) + Part I income by source + Part III COGS worksheet + `TAX borrowing`/Marcus set-aside memo. Everything amounts-free in notifications; full detail stays in the sheet.
4. Optional stretch: same engine backfills the 2025 sheet (Open Question #9).
5. Post-season retro → write lessons into the `home-finances` skill.

**Success criteria:** every 2026 transaction from business accounts + approved personal-card items sits in `LLC Transactions` with a Schedule C line; COGS shown separately and subtracted before profit; year-end report matches what TurboTax's Schedule C interview asks for, line by line; weekly human time ≤ 5 minutes of tap-throughs.

---

## 10. Explicit non-goals / safety notes

- No accounts connected, no sheets modified, no money spent as part of producing this plan.
- Plan contains no transaction amounts or account numbers beyond masks already present in repo config.
- Family pipeline (home-budget) untouched; categories.json remains read-only rules source.
- Live pulls/writes remain gated on Enrique's approval per the home-finances skill rules.
