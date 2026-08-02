# Implementation notes — card-transaction lifecycle (#14)

Increment 1. What `israeli-bank-scrapers` actually exposes for Isracard, the
settlement-date source that follows from that, and the opt-in machinery added on
top. Nothing here changes default behavior; every new path is behind
`actual.clearOnChargeDate` (default off).

## What israeli-bank-scrapers exposes for Isracard (verified in code)

Read from `node_modules/israeli-bank-scrapers/lib/scrapers/base-isracard-amex.js`
(the Isracard scraper is a thin subclass — `isracard.js`) and `transactions.d.ts`.

The scraper fetches the **monthly statement** view: `reqName=CardsTransactionsList`
by `month`/`year`, then `convertTransactions()` maps each raw row. Per row it
emits: `type`, `identifier` (voucher `voucherNumberRatz`), `date` (purchase date,
`fullPurchaseDate`), `processedDate`, `originalAmount`/`originalCurrency`,
`chargedAmount`/`chargedCurrency`, `description` (merchant), `memo` (`moreInfo`),
optional `installments`, and optional `category` (only when
`additionalTransactionInformation` is on — a `PirteyIska_204` sub-fetch).

What it does **NOT** expose — the gap that defines this feature:

- **No pending charges.** `status` is hard-coded to `TransactionStatuses.Completed`
  for every row (`base-isracard-amex.js` ~line 111). The `אושר וטרם נקלט`
  ("approved, not yet captured") bucket is never returned. → sourced separately
  from the Isracard **DigitalV3** web app (`GetTransactionsList`) by the existing
  `src/scraper/isracardPending.ts`.
- **No reliable per-transaction bank charge date.** `processedDate` is
  `txn.fullPaymentDate` if present, else the account's monthly `billingDate`
  (~line 98). Live evidence (2026-08-02, `docs/card-lifecycle-design.md`) shows
  it reports the **monthly statement date** (e.g. 08-19) for direct-debit rows,
  not the real bank charge date (~07-19/07-31). So `processedDate` off the raw
  scraper is **not** a trustworthy clearing clock.
- **No three-bucket split.** The Isracard UI separates `אושר וטרם נקלט` (pending),
  `עסקאות בחיוב מחוץ למועד` (direct debits, each showing `חיוב בחשבון הבנק ב־DD.MM.YY`
  = the real bank charge date), and `עסקאות למועד חיוב` (regular monthly). The
  scraper **flattens** all of this into one list of `Completed` rows dated on the
  monthly date. The per-purchase `מחוץ למועד` bank-charge-date is discarded.

Constraint respected: nothing under `node_modules` is modified. All enrichment
lives in budgetman-sync.

## Chosen settlement-date source

**FIBI settlement drill-down (`SUGBAKA=211`) — Option A.** Because the scraper
neither surfaces the `מחוץ למועד` bank-charge-date nor the pending bucket, the
authoritative real charge date must come from FIBI's own drill-down behind each
`0041 - ישראכרט` debit (endpoint in `docs/card-lifecycle-design.md`). Pending
names come from Isracard DigitalV3 (`isracardPending.ts`, already wired). This
matches the design doc's recommendation: Isracard supplies pending + names, FIBI
supplies the authoritative charge date + the reconciliation anchor.

The provider is written to read the charge date from each transaction's
`processedDate`. The enrichment step's job (blocked on live access, below) is to
populate `processedDate` with the real bank charge date — either from the FIBI
drill-down (scaffolded here) or, if a future capture proves the Isracard
`מחוץ למועד` date is reachable, from there. The provider logic is source-agnostic.

## What this increment implements (all opt-in, default off)

1. **Config flag** `storage.actual.clearOnChargeDate` (zod, default `false`;
   requires `upsert`). Documented in `src/config.schema.ts` with the trap that it
   only helps once `processedDate` carries the true charge date.

2. **Cleared-from-charge-date in the Actual provider** (`toIncoming`,
   `src/bot/storage/actual.ts`). When the flag is on, a **settled** domestic card
   charge is written to Actual dated on its **bank charge date** (`processedDate`,
   TZ-safe) and cleared; its still-**pending** twin stays uncleared on the
   purchase date. The pending↔settled **match key still uses the purchase date**,
   so the existing FX-stable/card-key collapse is unaffected. When the flag is
   off, the date/clear logic is byte-for-byte the upstream behavior.

3. **Planner extension** (`actualUpsert.ts`): `PlanOptions.updateDateOnSettle`
   (default off). When on, an in-place settle also moves the row's `date` to the
   settled charge date. `category` is still never in an update. New settled rows
   (no pending twin) carry their charge date via the normal add path.

4. **TZ-safe date helper** (`src/bot/storage/dates.ts`, `toJerusalemDate`). All
   new date→`YYYY-MM-DD` conversions go through `Asia/Jerusalem`. This prevents
   re-introducing the duplicate-import bug: FIBI stamps at 21:00 UTC = Israel
   midnight, so a UTC/local formatter shifts the calendar date (and thus the
   hash) by a day. Off-flag paths keep the upstream UTC formatting untouched.

5. **FIBI drill-down scaffold** (`src/scraper/fibiCardExpenses.ts`):
   `buildFibiCardExpensesUrl`, an HTML `parseFibiCardExpenses`, and
   `convertFibiExpenseToTransaction` (purchase date → `date`; real charge date →
   `processedDate`), plus a best-effort `fetchFibiCardExpenses` that drives the
   authenticated FIBI puppeteer session (mirrors `isracardPending.ts`). Unit-tested
   against a saved fixture (`src/scraper/__fixtures__/fibiCardExpenses.html`).

## Blocked on live bank access (owner-gated)

- **Verify the drill-down HTML shape.** The fixture is a best-effort
  reconstruction from the design doc's column list. The parser's column mapping
  and the exact servlet params (`I-SEL-MS-KARTIS` format, `B_SUGBAKA`) must be
  confirmed against a real capture before `fetchFibiCardExpenses` is trusted.
- **Confirm `processedDate` population.** Whether the real charge date reaches the
  provider depends on the enrichment writing it into `processedDate`. Not wired
  into the scrape flow yet (no default-flow change) — enable once validated.
- **Refunds / FX finalisation / multi-purchase debits** (N:1 drill-down rows)
  need real examples to lock down matching. The stable-key engine already handles
  pending→settled collapse and same-day disambiguation.

## Decisions to confirm with the owner

- Naming: flag is `clearOnChargeDate`. Confirm before it's documented in configs.
- Source of the charge date: FIBI drill-down (Option A) is chosen. If a clean
  Isracard `מחוץ למועד` capture is preferred (single source, Option B), the
  provider needs no change — only the enrichment that fills `processedDate`.
