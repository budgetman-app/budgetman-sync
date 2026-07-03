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

## Troubleshooting

- **`out-of-sync-migrations` error** — The budget database and the `@actual-app/api` version are out of sync. Ensure your Actual Budget server and moneyman's `@actual-app/api` dependency use compatible versions. Update both to their latest releases, or pin them to matching versions. See [actualbudget/actual#3656](https://github.com/actualbudget/actual/issues/3656) for context.

  You may see a generic error in the logs (e.g. `Failed to initialize Actual Budget: No budget file is open`). The underlying cause appears earlier in the console as `Error updating Error: out-of-sync-migrations` — look for that when diagnosing.
