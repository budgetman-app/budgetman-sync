import z from "zod/v4";

// TODO: Use the actual login field combinations from israeli-bank-scrapers once available
// Account configuration schema based on israeli-bank-scrapers login field combinations
const AccountSchema = z.looseObject({
  companyId: z.string().min(1, { error: "Company ID is required" }),
  password: z.string().min(1, { error: "Password is required" }),
});

// Storage provider schemas
export const GoogleSheetsSchema = z.object({
  serviceAccountPrivateKey: z
    .string()
    .min(1, { error: "Google private key is required" }),
  serviceAccountEmail: z.email({
    error: "Invalid Google service account email",
  }),
  sheetId: z.string().min(1, { error: "Google Sheet ID is required" }),
  worksheetName: z.string().min(1, { error: "Worksheet name is required" }),
});

export const YnabSchema = z.object({
  token: z.string().min(1, { error: "YNAB token is required" }),
  budgetId: z.string().min(1, { error: "YNAB budget ID is required" }),
  accounts: z.record(z.string(), z.string()),
});

export const AzureSchema = z.object({
  appId: z.string().min(1, { error: "Azure app ID is required" }),
  appKey: z.string().min(1, { error: "Azure app key is required" }),
  tenantId: z.string().min(1, { error: "Azure tenant ID is required" }),
  databaseName: z.string().min(1, { error: "Database name is required" }),
  tableName: z.string().min(1, { error: "Table name is required" }),
  ingestionMapping: z
    .string()
    .min(1, { error: "Ingestion mapping is required" }),
  ingestUri: z.url({ error: "Invalid ingest URI" }),
});

export const BuxferSchema = z.object({
  userName: z.string().min(1, { error: "Buxfer username is required" }),
  password: z.string().min(1, { error: "Buxfer password is required" }),
  accounts: z.record(z.string(), z.string()),
});

export const ActualSchema = z.object({
  serverUrl: z.url({ error: "Invalid Actual Budget server URL" }),
  password: z.string().min(1, { error: "Actual Budget password is required" }),
  budgetId: z.string().min(1, { error: "Actual Budget ID is required" }),
  accounts: z.record(z.string(), z.string()),
  // Opt-in, default-off additions (budgetman). Keep upstream behavior unchanged.
  // keepPending: import pending scraper transactions (as uncleared) instead of
  // skipping them. upsert: match pending->settled on the FX-stable
  // originalAmount+originalCurrency key and update the row in place.
  keepPending: z.boolean().default(false),
  upsert: z.boolean().default(false),
  // clearOnChargeDate (budgetman card lifecycle, #14): when on, a SETTLED
  // domestic card charge is written to Actual dated on its real BANK CHARGE
  // DATE (the transaction's processedDate — set by the FIBI settlement
  // drill-down / Isracard "מחוץ למועד" bank-charge-date enrichment) instead of
  // the purchase date, and marked cleared; the still-pending twin stays
  // uncleared at the purchase date. This is what makes Actual's cleared balance
  // reconstruct FIBI's posted running balance day-by-day. The pending<->settled
  // MATCH key still uses the purchase date, so the collapse is unaffected.
  // TRAP: only meaningful once processedDate carries the true charge date (the
  // raw israeli-bank-scrapers Isracard feed reports the monthly statement date,
  // NOT the bank charge date — see docs/impl-notes-card-lifecycle.md). Requires
  // upsert. Default off leaves the purchase-date/clear-on-complete behavior.
  clearOnChargeDate: z.boolean().default(false),
  // anchorFxToFibi (budgetman): make an Isracard FX PENDING charge's provisional
  // ILS amount match FIBI's current auth-hold ILS, so Actual's working balance
  // tracks FIBI's current balance during reconciliation. Both sides' ILS is a
  // provisional estimate that re-quotes until settlement; we deliberately follow
  // FIBI's number each scrape. FIBI's excluded auth rows ("דירקט מטח אושר-ישרא")
  // are used ONLY as an amount source (never imported). Matched by date window +
  // amount; only the ILS `chargedAmount` is overridden — originalAmount/currency/
  // merchant are untouched, so the FX-stable pending->settled collapse is
  // unaffected. A settled (non-pending) charge is never anchored (it already
  // carries the final ILS, which equals FIBI's settled). Default off = no-op.
  anchorFxToFibi: z.boolean().default(false),
  // excludeDescriptions: case-insensitive regular expressions; a transaction
  // whose description matches any of them is dropped before import. Needed when
  // a card and the checking account it settles against both map to the same
  // Actual account — the bank's aggregate card-settlement lines would otherwise
  // double-count the card's own per-purchase rows. Empty (the default) is a no-op.
  excludeDescriptions: z
    .array(z.string().min(1))
    .default([])
    .refine(
      (patterns) =>
        patterns.every((p) => {
          try {
            new RegExp(p, "i");
            return true;
          } catch {
            return false;
          }
        }),
      { error: "excludeDescriptions must contain valid regular expressions" },
    ),
  // cardPendingDescriptions: case-insensitive regexes identifying the bank's
  // per-purchase card PENDING authorizations (e.g. FIBI "אושר-ישראכרט"). When
  // set, matching rows are NOT excluded — they are imported as pending
  // placeholders and reconciled in place with the card issuer's settled granular
  // row (matched on the domestic amount + purchase date), so a recent card
  // charge is visible immediately and never double-counted when it settles.
  // Requires upsert. Empty (the default) leaves behavior unchanged.
  cardPendingDescriptions: z
    .array(z.string().min(1))
    .default([])
    .refine(
      (patterns) =>
        patterns.every((p) => {
          try {
            new RegExp(p, "i");
            return true;
          } catch {
            return false;
          }
        }),
      {
        error: "cardPendingDescriptions must contain valid regular expressions",
      },
    ),
});

export const WebPostSchema = z.object({
  url: z.url({ error: "Invalid web post URL" }),
  authorizationToken: z
    .string()
    .min(1, { error: "Authorization token is required" }),
});

export const SqlStorageSchema = z.object({
  connectionString: z
    .string()
    .min(1, { error: "SQL connection string is required" }),
  schema: z
    .string()
    .min(1, { error: "Schema name is required" })
    .regex(/^[A-Za-z_]\w*$/, {
      message:
        "Schema name must start with a letter or underscore and contain only letters, numbers, or underscores",
    })
    .default("moneyman"),
});

export const LocalJsonSchema = z.object({
  enabled: z.boolean(),
  path: z.string().optional(),
});

export const MoneymanDashSchema = z.object({
  token: z.string().min(1, { error: "Moneyman Dash token is required" }),
});

export const TelegramStorageSchema = z.object({
  /**
   * Whether to send transactions as a JSON file to the Telegram chat.
   * When enabled, all scraped transactions will be sent to your Telegram chat.
   * This is independent of notification messages (errors, progress, etc.) which
   * are controlled by options.notifications.telegram.
   * @default true
   */
  enabled: z.boolean().default(true),
});

// Storage configuration schema
export const StorageSchema = z
  .object({
    googleSheets: GoogleSheetsSchema.optional(),
    ynab: YnabSchema.optional(),
    azure: AzureSchema.optional(),
    buxfer: BuxferSchema.optional(),
    actual: ActualSchema.optional(),
    localJson: LocalJsonSchema.optional(),
    webPost: WebPostSchema.optional(),
    sql: SqlStorageSchema.optional(),
    telegram: TelegramStorageSchema.optional(),
    moneyman: MoneymanDashSchema.optional(),
  })
  .refine((data) => Object.values(data).some(Boolean), {
    error: "At least one storage provider must be configured",
  })
  .default({ localJson: { enabled: true } });

// Options schemas
export const ScrapingOptionsSchema = z.object({
  accountsToScrape: z.array(z.string()).optional(),
  daysBack: z.number().min(1).max(365).default(10),
  futureMonths: z.number().min(0).max(12).default(1),
  // (budgetman, opt-in, default false) Fetch charges the provider has authorised
  // but not yet settled. This is a SCRAPING concern, so it lives here rather than
  // under a storage provider — a run can then be validated with localJson before
  // anything is written to a real ledger.
  includePendingCharges: z.boolean().default(false),
  // (budgetman card lifecycle #14, opt-in, default false) Run the FIBI settlement
  // drill-down enrichment: rewrite each Isracard card transaction's processedDate
  // to the REAL bank charge date fetched from FIBI's SUGBAKA=211 drill-down (see
  // docs/impl-notes-card-lifecycle.md). Like includePendingCharges this is a
  // SCRAPING concern, so it can be dry-run to localJson (the dumped JSON shows the
  // corrected processedDate) with NO Actual involvement. The Actual provider's
  // clearing on that date is a SEPARATE switch (storage.actual.clearOnChargeDate);
  // production turns that on, which also implies this enrichment. Enrichment fires
  // when this OR storage.actual.clearOnChargeDate is true.
  enrichCardChargeDates: z.boolean().default(false),
  transactionHashType: z.enum(["", "moneyman"]).default(""),
  additionalTransactionInfo: z.boolean().default(false),
  includeRawTransaction: z.boolean().default(false),
  hiddenDeprecations: z.array(z.string()).default([]),
  puppeteerExecutablePath: z.string().optional(),
  maxParallelScrapers: z.number().min(1).max(10).default(1),
  domainTracking: z.boolean().default(false),
});

export const SecurityOptionsSchema = z.object({
  firewallSettings: z.array(z.string()).optional(),
  blockByDefault: z.boolean().default(false),
});

export const NotificationOptionsSchema = z.object({
  telegram: z
    .object({
      apiKey: z.string().min(1, { error: "Telegram API key is required" }),
      chatId: z.string().min(1, { error: "Telegram chat ID is required" }),
      /**
       * Enable OTP (One-Time Password) support for 2FA authentication.
       * When enabled, the bot will ask for OTP codes via Telegram during scraping.
       */
      enableOtp: z.boolean().optional().default(false),
      /**
       * Maximum time in seconds to wait for OTP response from user.
       */
      otpTimeoutSeconds: z.number().min(30).max(600).optional().default(300),
      /**
       * Whether to send the log file to Telegram when using secure logging (MONEYMAN_UNSAFE_STDOUT=false).
       * Only applies when output redirection is enabled.
       * @default true
       */
      sendLogFileToTelegram: z.boolean().optional().default(true),
    })
    .optional(),
});

export const LoggingOptionsSchema = z.object({
  getIpInfoUrl: z
    .union([z.literal(false), z.string().url()])
    .default("https://ipinfo.io/json"),
  debugFilter: z.string().optional().default("moneyman:*"),
});

const OptionsSchemaObject = z.object({
  scraping: ScrapingOptionsSchema.prefault({}),
  security: SecurityOptionsSchema.prefault({}),
  notifications: NotificationOptionsSchema.prefault({}),
  logging: LoggingOptionsSchema.prefault({}),
});

// Complete configuration schema
export const MoneymanConfigSchema = z
  .object({
    accounts: z.array(AccountSchema).default([]),
    storage: StorageSchema,
    options: OptionsSchemaObject.prefault({}),
  })
  .prefault({});

export type MoneymanConfig = z.infer<typeof MoneymanConfigSchema>;

export const IntEnvVarSchema = z
  .string()
  .transform((val) => Number.parseInt(val, 10))
  .catch(NaN);

export const BooleanEnvVarSchema = z
  .string()
  .transform((val) => val.toLowerCase() === "true" || val === "1")
  .catch(false);
