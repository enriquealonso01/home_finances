# BUILD-PHASE1.md — LLC Tax-Categorization System, Phase 1

Date: 2026-09-11 · Scope: TAX-PLAN.md Phase 1 (tax rules layer + backfill into LLC ledger) ·
Policy: this report contains COUNTS and category names only — no dollar amounts.

## What was built

1. **`config/tax_rules.json`** — layer-2 Schedule C rules (tax_year 2026):
   - Schedule C line map (8 Advertising, 8 Cleaning, 9 Car, 17 Legal/professional, 18 Office,
     23 Taxes & licenses, 24a Travel, 24b Meals 50%, 25 Utilities, 27a Other expenses,
     P1 income, P3 COGS).
   - Home-office mapping: 100% business-use apartment → rent → line 30 Home Office (form 8829),
     parking → line 30, utilities → line 25, phone/internet → line 25.
   - AT&T → 100% business; AutoDS per-order fulfillment → COGS (line P3, Part III);
     AutoDS SaaS subscription → line 27a / Part V software subscriptions.
   - Internal-category → sheet-category map + Plaid PFC fallback map.
2. **`scripts/tax_ledger.js`** — shared two-layer categorizer: layer 1 mirrors run_month.js
   CUSTOM_RULES + categories.json; layer 2 applies tax_rules.json. Exports
   `pullPlaidTransactions` (per-item fault-tolerant), `classifyInternal`, `applyTaxRules`.
3. **`scripts/backfill_tax.js`** — CLI `node scripts/backfill_tax.js [--apply] [--from] [--to]`.
   Stamps tax columns **U:AA** (Type / ScheduleC Line / TurboTax / BusUse / Pct / NeedsReview /
   Notes) on every in-window ledger row, appends new Plaid rows with Plaid tx-id in **AB**,
   idempotent by tx-id.
4. **`scripts/verify_tax.js`** — independent read-back verification (counts only).

## Sheet-layout incident and recovery (disclosed)

The first apply wrote tax stamps into **K:Q**, overwriting parts of the sheet's horizontal
sections (Equity K/L and Revenue O/P/Q) on affected rows. Recovery:

- Downloaded pre-damage Drive **revision 79** (Aug 10) of the spreadsheet via the revisions
  export API (xlsx) and extracted the LLC Transactions grid.
- Verified rev79↔current row alignment by B-column date on **all 1,373 legacy rows: 0
  mismatches**.
- Restored K:Q on 204 changed rows to exact rev79 values. Independent re-read verification:
  **1,373/1,373 rows match rev79 (0 mismatches)**.
- Migrated the 236 appended Plaid rows' stamps from the wrong columns into U:AA + AB.
- Rewrote `backfill_tax.js` to target U:AA/AB only; re-applied; re-verified K:Q still
  1,373/1,373 post-apply.

## Verified results (counts only)

- Plaid items pulled: 3 live items (630 + 37 + 72 raw transactions over the window);
  1 item failed with `ITEM_LOGIN_REQUIRED` and was skipped — its transactions are NOT included.
- Ledger rows in window 2026-01-01 → 2026-09-11: **440**; all **440** carry a tax stamp (0 unstamped).
- Plaid tx-ids recorded in AB: **236** (0 duplicates; matches state file exactly).
- By type: Expense 410, Refund 11, COGS 19.
- Review status: auto-classified **404**, Needs-Review **36** (8.2%).
- Business-use: business 404, personal 12, mixed-review 24.
- Schedule C lines (top): 27a Other expenses 238, 25 Utilities 33, 30 Home office 25,
  9 Car 22, 24b Meals 22 (50%), 18 Office 13, 24a Travel 11, 8 Advertising 10,
  P1 income 11, P3 COGS 19, 17 Legal 1, 23 Taxes & licenses 2, (none) 33.
- Family sheet: untouched (read-only verification shows all 9 tabs intact).
- `verify_sheets.js`: OK for both Family and LLC workbooks post-run.

## Known limitations

- **Plaid coverage gap**: the connected Chase item's history starts **2026-03-08**. The
  2026-01-01 → 2026-03-07 window is covered only by the manually entered ledger rows (which
  received tax stamps). No Plaid data exists for that period; not recoverable in this phase.
- Discover item is dead (`ITEM_LOGIN_REQUIRED`); not relinked (out of Phase-1 scope).
- The 36 Needs-Review rows (plus 24 mixed-review) await manual confirmation in the sheet.
