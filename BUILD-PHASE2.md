# BUILD-PHASE2.md — LLC Tax-Categorization System, Phase 2 (ingestion)

Date: 2026-09-11 · Scope: TAX-PLAN.md Phase 2 items 2–4 (Citi card backfill + Shopify payout
ingestion) · Policy: COUNTS and category names only — no dollar amounts.

## What was built

1. **Citi card wired into the backfill** — Citi AAdvantage Business MC ****5836
   (item `8qvgb…`, account `yze5g…`) added to `config/accounts.json` as
   `is_business: true`, llc label `Citi AA Biz 5836`. Its Plaid item was already live in
   `secrets/plaid_tokens.json`, so `pullPlaidTransactions` picked it up with no code change.
   Same idempotent stamps (U:AA + Plaid tx-id in AB), window 2026-01-01 → 2026-09-11.
2. **`scripts/shopify_payouts.js`** (new) — pulls **paid** payouts from the Shopify Admin API
   (`/admin/api/2024-01/shopify_payments/payouts.json`, client-credentials token from
   `/root/aidp/.env`, Link-header pagination). Per payout books TWO rows:
   - Income row: net payout amount, Schedule C line **P1** (gross receipts), category `Shopify`;
   - Expense row: processing fee, Schedule C line **10** (Commissions and fees),
     category `Platform Fees` (per `tax_rules.json`).
   Guardrails: aborts if any payout fails the identity check `gross − fees = net`
   (0 failures on the current data); aborts on a half-booked payout (one row present, the
   other not); date-ordered appends; idempotent via AB ids `shopify-payout:<id>` /
   `shopify-fee:<id>`; every row carries `payout_id` in AA notes. HARD RULE honored:
   appends only into B..F + U:AA + AB — never K:Q.
3. **`scripts/backfill_tax.js` hardening (two fixes)**
   - Notes preservation: the legacy-row restamper no longer blanks pre-existing AA notes when
     its recompute yields none (protects `payout_id` audit notes written by the Shopify script).
   - Engine-row ownership: rows that already carry an id in AB (Plaid- or Shopify-appended)
     are **never restamped** by the legacy-row stamper. The stamper sees only B..F text and
     classifies those rows *worse* than the engine that appended them (it cannot see Plaid
     merchant_name / PFC / the AutoDS subscription hint — dry-run showed it would flip AutoDS
     subscription rows to COGS and clear `pfc-only` review flags on 24 rows). Legacy
     manually-entered rows (AB empty) still get stamped exactly as in Phase 1.

## Verified results (counts only, independent read-back)

### Shopify payouts
- Paid payouts pulled: **33** (2026-07-02 → 2026-09-10), all USD, 0 duplicate ids.
- Identity check `gross − fees = net`: **0 failures**.
- Rows appended: **66** (33 Income line P1 + 33 Expense line 10), at sheet rows 1949–2014,
  date-ordered; all 66 carry a `payout_id` note; 0 unpaired income/fee rows.
- Re-run idempotency: second run appends **0** rows ("33 already ingested").

### Citi card backfill
- Citi transactions pulled over the window: 60 raw → **41 new ledger rows appended**
  (rows 2065–2105, 2026-08-10 → 2026-09-06; 88 transfers/non-purchases skipped,
  0 dupes). Types: 40 Expense, 1 Income.
- Classification: auto **8** / Needs-Review **33** (80%). BusUse: business 16,
  mixed-review 18, personal 7. Schedule C lines: 27a 12, 24b 9, (none) 13, 9 2, 25 2,
  30 1, P3 2. The high review rate is expected for a brand-new card (no merchant-rule
  history yet); Citi Plaid history starts 2026-08-10.

### Whole-ledger verification (`scripts/verify_tax.js` + custom read-back)
- Rows in window 2026-01-01 → 2026-09-11: **547**, all 547 stamped (0 unstamped) — **OK**.
- Plaid/Shopify ids in AB: 343 Plaid + 66 Shopify = **344 total incl. 1 legacy id**,
  **0 duplicates**.
- By type: Expense 483, Income 34, Refund 11, COGS 19. Review: auto 478 / Needs-Review 69.
- Appended region (rows 1949+): **0 non-empty cells in K:Q, G:J, R:T** — horizontal
  sections untouched (Phase-1 incident not repeated).
- `verify_sheets.js`: OK for both Family (9 tabs) and LLC (3 tabs) workbooks.

## Known limitations / notes
- Citi Plaid history begins 2026-08-10; earlier 2026 Citi activity is not recoverable via
  Plaid.
- 33 of 41 Citi rows need review — mostly merchants with no rule yet (airline/AAdvantage
  spend, gas, meals). The personal-flagged 7 rows (SeatGeek, movies, etc.) follow the §7.4
  business-card personal-purchase flow.
- The 1 'other' AB id is the Phase-1 legacy stamp, not introduced this phase.
- Payout income is booked as **net deposits** per Phase-2 task spec (with fees as a
  deductible line 10 expense); TAX-PLAN §5.2's gross-vs-net reconciliation upgrade (booking
  gross sales + refunds separately) remains future work.
- State files: `data/tax_backfill_state.json`, `data/shopify_payouts_state.json` (counts +
  ids, no amounts).
