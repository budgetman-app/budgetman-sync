# Export to [Actual Budget](https://actualbudget.org/)

Export transactions directly to your Actual Budget server.

Use the following configuration to setup:

```typescript
storage: {
  actual?: {
    /**
     * The URL of your Actual Budget server
     */
    serverUrl: string;
    /**
     * The password for your Actual Budget server
     */
    password: string;
    /**
     * The ID of the budget where you want to import the data
     */
    budgetId: string;
    /**
     * A key-value list to correlate each account with the Actual Budget account ID
     */
    accounts: Record<string, string>;
    /**
     * (budgetman, opt-in, default false) Import pending scraper transactions
     * instead of skipping them. Pending rows are added as uncleared
     * (`cleared: false`) so they reduce the envelope immediately.
     */
    keepPending?: boolean;
    /**
     * (budgetman, opt-in, default false) Match a pending charge to its settled
     * twin on the FX-stable `originalAmount + originalCurrency` key and update
     * the existing row in place (amount + cleared) instead of adding a
     * duplicate. Never overwrites the transaction's category.
     */
    upsert?: boolean;
    /**
     * (budgetman, opt-in, default `[]`) Case-insensitive regular expressions.
     * A transaction whose description matches any of them is dropped before
     * import. Use this when a card and the checking account it settles against
     * both map to the same Actual account.
     */
    excludeDescriptions?: string[];
  };
};
```

## accounts

A `JSON` key-value pair structure representing a mapping between two identifiers. The `key` represents the account ID as understood by moneyman (from web scraping the financial institutions) and the `value` is the account ID from your Actual Budget server.

Example:

```json
{
  "5897": "actual-account-id-123"
}
```

**Note:** Pending transactions are skipped during import by default. Set
`keepPending: true` to import them as uncleared, and `upsert: true` to update a
pending row in place when it later settles (matched on the FX-stable
`originalAmount + originalCurrency` key) rather than importing a duplicate. Both
default to `false`, so leaving them unset preserves the default behavior.

### Isracard pending

The standard Isracard scraper only returns settled charges. When `keepPending`
is on, budgetman additionally fetches the "not yet settled" (approvals) charges
from Isracard's web app (`web.isracard.co.il`) using the already-authenticated
session, so pending FX charges surface immediately with their
`originalAmount`/`originalCurrency`. This is best-effort — if it fails, the
settled import is unaffected. Two caveats:

- If you run with a strict domain firewall (`security.blockByDefault: true`),
  allow `web.isracard.co.il` in addition to the usual scraper domains.
- The Isracard **site password must be 8–20 characters, letters and digits only**
  (the scraper's login API rejects symbols, even though the website accepts them).

### Avoiding double-counted card spend

If you map both a credit card and the checking account it settles against to the
**same** Actual account, you will import the same spending twice: once as the
card's individual purchases, and again as the bank's aggregate settlement line
for the whole bill. `excludeDescriptions` drops the aggregate line so the
granular card rows remain the single source of truth:

```jsonc
"actual": {
  // ...
  "excludeDescriptions": ["אושר-ישרא"]
}
```

Patterns are case-insensitive JavaScript regular expressions matched against the
transaction description, and an invalid one fails at config load rather than
mid-scrape. Prefer a **substring pattern over an exact string** — banks truncate
long descriptions, so the same line can appear in more than one form (e.g.
`דירקט אושר-ישראכרט` and `דירקט מטח אושר-ישרא`).

Validate your patterns against real data before relying on them: run a scrape
with the `localJson` storage (or check the log lines reading
`excluded "<description>" ... — matched /<pattern>/`) and confirm that exactly
the aggregate lines, and nothing else, are being dropped.

## Troubleshooting

- **`out-of-sync-migrations` error** — The budget database and the `@actual-app/api` version are out of sync. Ensure your Actual Budget server and moneyman's `@actual-app/api` dependency use compatible versions. Update both to their latest releases, or pin them to matching versions. See [actualbudget/actual#3656](https://github.com/actualbudget/actual/issues/3656) for context.

  You may see a generic error in the logs (e.g. `Failed to initialize Actual Budget: No budget file is open`). The underlying cause appears earlier in the console as `Error updating Error: out-of-sync-migrations` — look for that when diagnosing.
