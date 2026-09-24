# BUILD — Expenses & Revenue tabs (2026-09-11)

Enrique rejected the phase-1/2 sectioned ledger design and created two clean tabs in the
LLC sheet. This rebuild replaces the cluttered 28-column layout with one row per
transaction per tab. `LLC Transactions` is RETIRED (read-only from here on — it still
holds 2025+2026 history and the tax stamps we migrated from).

## Tab design (identical headers on both tabs)

| Col | Header | Notes |
|-----|--------|-------|
| A | Date | ISO `YYYY-MM-DD` |
| B | Description | Plaid name / legacy hand-entered description |
| C | Amount | positive number; sign convention per tab (expenses positive out, revenue positive in) |
| D | Sch C Line | Schedule C line number (9, 10, 17, 23, 24a, 24b, 25, 27a, 30, P1) |
| E | Sch C Label | TurboTax label (Car expenses, Commissions and fees, Meals, …) |
| F | Source | Chase / Citi / Shopify / Manual (row provenance: which feed produced it) |
| G | Card | P&S CHK 2502 · P&S Credit 5441 · Citi AA Biz 5836 · Shopify Krendora |
| H | Review | `Y` = needs human review (PFC-only guess, personal-flag on biz card, unmatched) |
| I | Notes | Part V label, `pfc-only`, `pending`, `payout_id:…` audit trail |
| J | Ref/ID | Plaid transaction_id or `shopify-payout:<id>` / `shopify-fee:<id>` — idempotency key |

Header row bold + frozen. Routing by the retired ledger's tax-stamp Type (col U):
`Expense`/`COGS` → **Expenses**; `Income`/`Refund` (contra-revenue) → **Revenue**.

## Verified counts (2026 YTD, migrated from LLC Transactions stamps U:AA + ids AB)

- **Expenses: 502 rows** = 483 Expense + 19 COGS. By source: Manual 193, Chase 236, Shopify 33, Citi 40.
- **Revenue: 45 rows** = 34 Income + 11 Refund. By source: Manual 11, Shopify 33, Citi 1.
- Shopify payout pairs: 33 payouts × 2 rows (net income row + fee row, line 10).
- Review-flagged: 69 rows (all on Expenses).
- Read-back check: 0 malformed rows, 0 duplicate ids, per-month distribution matches source.
- Sum check: 502 + 45 = 547 = total stamped 2026 rows in the retired ledger. Exact match.

## Tooling

- `scripts/build_expenses_revenue.js [--apply]` — permanent, idempotent rebuild of both
  tabs from the retired ledger. Full clear + rewrite each run; safe to re-run any time
  the retired ledger gains rows (e.g. after new backfills).
- `scripts/backfill_tax.js`, `scripts/shopify_payouts.js` remain the ingestion engines —
  they still write to `LLC Transactions` (retired) so new rows land there, then re-run
  the rebuild script to propagate to the new tabs.
- Read-back: `scripts/tmp/verify_tabs.mjs` (counts only).

## Plaid full-year history investigation (the "Jan–Mar gap")

**Answer: the data does not exist on Plaid's side. It is not retrievable.**

Tested for real against Plaid production (read-only `/transactions/get`, explicit
`start_date=2026-01-01`, `end_date=2026-03-07`, count 500 pagination for every item):

| Item | Institution | Jan 1–Mar 7 txns | Full-history earliest |
|------|-------------|------------------|----------------------|
| 4pYVVL3w | Chase (5 accts incl. both business) | 0 | **2026-03-08** |
| Mq6q06mB | Marcus savings ×2 | 0 | 2026-03-10 |
| 0LaqAw61 | Wells Fargo | 0 | 2026-03-09 |
| JXMErM7Q | **Discover — ITEM_LOGIN_REQUIRED (needs re-auth)** | error | — |
| 8qvgbRBQ | Citi AA Biz 5836 | 0 | 2026-08-09 (linked that day) |
| PP50NK1b | Krendora (Shopify bank feeds) | 0 | 2026-07-15 |

- Every item's history begins within days of its Link date. Chase was linked ~2026-03-08,
  so Plaid never received Jan 1–Mar 7 — banks holding 730 days doesn't help; Plaid only
  returns what it has synced since item creation. `/transactions/get` with explicit dates,
  pagination, `days_to_request`, and `/transactions/refresh` all confirmed this (no error,
  just `total_transactions: 0` for the window).
- **Options for the gap:** (a) manual CSV export from Chase.com for Jan–Feb business
  accounts (Chase allows 90-day+ statement windows; statements are forever), or
  (b) accept the gap. The retired ledger already has 9 hand-entered rows in Jan–Feb.
- **Action needed:** Discover item `JXMErM7Q…` is in `ITEM_LOGIN_REQUIRED` — re-auth via
  `https://jarvis.enriquecodes.com/plaid-link/`. It's personal-only, so not blocking, but
  the family pipeline is skipping it entirely until fixed.

## Untouched (per orders)

Summary, LLC Transactions (read-only), TAX borrowing — verified present and untouched.
No dollar amounts appear in this doc or in any agent summary, per policy.

## Dupes + misfiled income (2026-09-11 cleanup)

### A) Duplicates — 25 same-key groups found (Date+Desc+Amount), 16 dup rows removed

Decisions were made against the retired **LLC Transactions** ledger as source of truth
(it held 344 unique Chase/Citi Plaid transaction_ids, **zero** ids appearing twice — so
no pending→posted double-pulls existed anywhere; every distinct-Plaid-id group is genuine):

- **15 Manual+Plaid overlap groups** (7-Eleven ×3, WEBSHARE ×2, Shake Shack, Costco, Play,
  TX VERIFY ×3, Lyft 7-17, AA 5-24 ×2 manual twins, River Landing Parking → n/a, etc.):
  kept the Plaid row (Ref/ID present, better merchant data), deleted the Manual twin — **16 rows removed**.
- **Chase+Chase / Citi+Citi same-day groups** (MOXEE MOBILE 7-17/7-19/8-13/8-14, TELLO x5,
  Lyft 7-29, AA Chase pair, River Landing, DECODO): **all kept** — every row has a distinct
  Plaid transaction_id verified 1:1 in the ledger (incl. the "two $1.40 WEBSHARE renewals"
  case pattern; those were Manual+Plaid overlaps, already covered above).
- **All-manual groups** (Facebook $2 x3 on 07-03, Moxee x2 + x3 manual, TELLO refund x4 in
  Revenue): matched against ledger row counts for same date+amount+desc — ledger has the
  same number of rows (e.g. three Facebook $2 charges on 07-03), so **kept all** (0 removed).
- **Revenue tab**: only the TELLO refund x4 group — ledger confirms 4 refund rows → kept.

Net: 25 groups inspected → 15 groups touched, 16 dup rows removed from Expenses, 0 from Revenue
(after the TF coordination in B, which removes Revenue rows that were the *same transaction*,
not duplicates in the dup-group sense).

### B) TF Zelle income moved Expenses → Revenue — 15 rows

The bank-side rows `Zelle payment from TICKET FLIPPING, LLC` (Source=Chase, Card=P&S CHK 2502,
Plaid Ref/ID present, 2026-03-09 → 2026-09-08) were misfiled in **Expenses**. All 15 moved to
**Revenue** with Sch C Line `1`, Label `Gross receipts / sales`, Source `Chase`, original
Plaid Ref/ID preserved.

Coordination with the legacy-append task: **every one of the 15 bank rows had a date+amount-
identical twin already in Revenue** — 13 `legacy-rev:*` rows (the legacy 2025-sheet manual
payouts, rows 8-16/18/20/22/23) and 2 `zelle-tf:*` rows (08-24, 09-08). Per the keep-Plaid
policy those 15 manual/legacy twins were removed so each payout appears exactly once, now
represented by its bank-verified Plaid row. They are NOT lost: the information content
(legacy ledger row number, descriptive text) was preserved in the moved rows' Notes column
as `ledger legend: <original description>`. No Mar–Aug payout was deduped against a
non-identical sibling.

### C) Verification (read-back, independent scripts)

- `build_expenses_revenue.js` check mode: reconciles (expenses=502 pre-cleanup baseline,
  dupes=0 by id, legacy added=19, bank TF added=2 — consistent with post-cleanup state).
- Fresh read-back: Expenses **471** rows, Revenue **66** rows, malformed 0, frozen header intact.
- Same-Ref duplicate rows across both tabs: **0**.
- TF rows remaining in Expenses: **0**; TF bank rows in Revenue: **15**, all
  Sch C 1 / Gross receipts / sales / Chase with Plaid ref.
- Remaining same-key groups in Expenses: 12 — all verified genuine (distinct Plaid ids or
  ledger-matched manual counts).
- Untouched: Summary, LLC Transactions (read-only), TAX borrowing.

### Reconciliation

Expenses 502 → 471 = −16 dup rows −15 TF rows moved out. Revenue 66 → 66 = +15 moved-in
bank rows −15 removed legacy/zelle twins.

Scripts used (kept for audit): `scripts/tmp/dedupe_analyze.mjs`, `dedupe_crosscheck.mjs`,
`dedupe_ledger_groups.mjs`, `dedupe_revenue_full.mjs`, `dedupe_apply.mjs`,
`dedupe_verify_readback.mjs`.

## Final judgment pass — same-day duplicate-looking rows verified against live Plaid (2026-09-11)

Method: pulled all live Plaid items' 2026 transactions (5 items OK; Discover personal item in
ITEM_LOGIN_REQUIRED, not needed — all suspect rows are Chase/Citi). Classified every sheet Ref:
posted transaction_id vs pending_transaction_id; pending→posted lifecycle deduped by
pending_transaction_id linkage (zero posted txns share a pending_transaction_id; sheet refs map
1:1 to live posted transactions, 0 unmatched).

### Per-case verdicts

- **American Airlines pair (Expenses)**: Plaid shows two DISTINCT posted transactions on one
  Chase card, both authorized the same day, no pending_transaction_id linkage in either
  direction. Both kept. The retired ledger's twin manual entries (rows 91-92) are hand-entry
  shadows of these two real charges; they were not in Expenses and LLC Transactions is untouched.
- **Moxee 7/17**: bank posted exactly 2 charges that day (both without pending lineage) → the 2
  Manual no-ref rows removed, the 2 Plaid rows kept. **Moxee 7/19**: bank posted 3 (each with its
  own pending_transaction_id) → 3 Manual rows removed, 3 Plaid rows kept. Moxee 8/13, 8/14 groups
  re-verified the same way: Plaid row counts == bank counts, all kept.
- **TELLO refund x4 (Revenue rows 24-27)**: live Plaid shows exactly 4 distinct posted refund
  credits on 7/17 (each with its own pending_transaction_id, none linked to each other) — the
  bank really posted 4. **All 4 kept.** His manual quadrupling happened to be correct.
- **Tello expense rows**: each manual Tello row twinned a same-day posted Plaid charge
  (7/14, 7/15, 7/16 singles; 7/17 manual twin of the one charge that day) → manual twins removed,
  5 Plaid rows kept on 7/17.
- **Rule-B sweep (beyond the flagged cases)**: same rule applied across all of Expenses — Manual
  no-ref rows matching a live-verified Plaid row same-day/same-amount/same-merchant, where the
  group's Plaid rows covered the bank's outflow count → **160 Manual twins removed** (includes
  the AA-adjacent Apple, the Moxee/Tello cases above, plus ~140 more: Lovable, Fal, Vidu, Upload,
  Autods, AWS, AT&T, FPL, River Landing parking/rent, FACEBK, Cursor, OpenAI, service fees, etc.).
- **Kept manual rows**: all pre-Plaid-era rows (Jan–Feb, before Chase was linked — bank has no
  data), Autods Balance rows (no Plaid row exists in their groups), Cmx Cinemas, Autods LTD —
  nothing matched by the rule was dropped; nothing unmatched was touched.
- **Remaining same-key groups**: Expenses 9 (AA x2, Moxee 7/17 x2, TELLO x5, Moxee 7/19 x3,
  Lyft x2, Moxee 8/13 x2, Moxee 8/14 x2, River Landing Parking x2, DECODO x2) — every row a
  distinct live posted Plaid id, counts == bank truth. Revenue 1 (TELLO x4, bank-verified).
- Duplicate non-empty Refs across both tabs after cleanup: **0**.

### Reconciliation

Expenses 471 → 311 (−160 Manual twins). Revenue 66 → 66 (unchanged; TELLO x4 kept).

Scripts (audit trail): `scripts/tmp/plaid_pull_all_items.mjs` (full per-item pull),
`judge_crosscheck.mjs` (ref classification + group parity), `judge_parity.mjs` (id-level parity),
`judge_apply.mjs` (rule-B dry/apply with bank-count guard), `judge_verify_readback.mjs`
(fresh read-back). Untouched: Summary, LLC Transactions (read-only), TAX borrowing.
