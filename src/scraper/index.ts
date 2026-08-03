import { performance } from "perf_hooks";
import { getAccountTransactions } from "./scrape.js";
import { AccountConfig, AccountScrapeResult, ScraperConfig } from "../types.js";
import { createLogger } from "../utils/logger.js";
import { loggerContextStore } from "../utils/asyncContext.js";
import { createBrowser, createSecureBrowserContext } from "./browser.js";
import { getFailureScreenShotPath } from "../utils/failureScreenshot.js";
import { CompanyTypes, ScraperOptions } from "israeli-bank-scrapers";
import type { BrowserContext } from "puppeteer";
import { parallelLimit } from "async";
import { config } from "../config.js";
import { fetchIsracardPendingByAccount } from "./isracardPending.js";
import {
  enrichFibiCardChargeDates,
  isIsracardSettlementDebit,
} from "./cardChargeDates.js";
import type { Transaction } from "israeli-bank-scrapers/lib/transactions.js";
import { TransactionStatuses } from "israeli-bank-scrapers/lib/transactions.js";

const logger = createLogger("scraper");

export const scraperOptions: Partial<ScraperOptions> = {
  navigationRetryCount: 3,
  viewportSize: { width: 1920, height: 1080 },
  optInFeatures: [
    "mizrahi:pendingIfHasGenericDescription",
    "mizrahi:pendingIfNoIdentifier",
    "mizrahi:pendingIfTodayTransaction",
    "isracard-amex:skipAdditionalTransactionInformation",
  ],
};

export async function scrapeAccounts(
  {
    accounts,
    startDate,
    futureMonthsToScrape,
    parallelScrapers,
    additionalTransactionInformation,
    includeRawTransaction,
  }: ScraperConfig,
  scrapeStatusChanged?: (
    status: Array<string>,
    totalTime?: number,
  ) => Promise<void>,
  onError?: (e: unknown, caller: string) => void,
) {
  const start = performance.now();

  logger(`scraping %d accounts`, accounts.length);
  logger(`start date %s`, startDate.toISOString());

  let futureMonths: number | undefined = undefined;
  if (!Number.isNaN(futureMonthsToScrape)) {
    logger(`months to scrap: %d`, futureMonthsToScrape);
    futureMonths = futureMonthsToScrape;
  }

  const status: Array<string> = [];

  logger("Creating a browser");
  const browser = await createBrowser();
  logger(`Browser created, starting to scrape ${accounts.length} accounts`);

  // Retain each account's authenticated browser context so a post-scrape,
  // cross-account step (card charge-date enrichment) can reuse the FIBI session
  // after all scrapes finish. Contexts stay alive until browser.close() below.
  const contextByCompany = new Map<CompanyTypes, BrowserContext>();

  const results = await parallelLimit<AccountConfig, AccountScrapeResult[]>(
    accounts.map((account, i) => async () => {
      const { companyId } = account;
      return loggerContextStore.run(
        { prefix: `[#${i} ${companyId}]` },
        async () => {
          const browserContext = await createSecureBrowserContext(
            browser,
            companyId,
          );
          contextByCompany.set(companyId, browserContext);
          return scrapeAccount(
            account,
            {
              // Safe to remove when israeli-bank-scrapers upgrades to puppeteer 25+
              browserContext: browserContext as any,
              startDate,
              companyId,
              futureMonthsToScrape: futureMonths,
              storeFailureScreenShotPath: getFailureScreenShotPath(companyId),
              additionalTransactionInformation,
              includeRawTransaction,
              ...scraperOptions,
            },
            async (message, append = false) => {
              status[i] = append ? `${status[i]} ${message}` : message;
              return scrapeStatusChanged?.(status);
            },
            browserContext,
          );
        },
      );
    }),
    Number(parallelScrapers),
  );
  await enrichCardChargeDates(results, contextByCompany);

  const duration = (performance.now() - start) / 1000;
  logger(`scraping ended, total duration: ${duration.toFixed(1)}s`);
  await scrapeStatusChanged?.(status, duration);

  try {
    logger(`closing browser`);
    await browser?.close();
  } catch (e) {
    onError?.(e, "browser.close");
    logger(`failed to close browser`, e);
  }

  logger(getStats(results));
  return results;
}

function getStats(results: Array<AccountScrapeResult>) {
  let accounts = 0;
  let transactions = 0;

  for (let { result } of results) {
    if (result.success) {
      accounts += result.accounts?.length ?? 0;
      for (let account of result.accounts ?? []) {
        transactions += account.txns?.length;
      }
    }
  }

  return {
    accounts,
    transactions,
  };
}

async function scrapeAccount(
  account: AccountConfig,
  scraperOptions: ScraperOptions,
  setStatusMessage: (message: string, append?: boolean) => Promise<void>,
  browserContext?: BrowserContext,
) {
  logger(`scraping started`);

  const scraperStart = performance.now();
  const result = await getAccountTransactions(
    account,
    scraperOptions,
    (cid, step) => setStatusMessage(`[${cid}] ${step}`),
  );

  await mergeIsracardPending(account, result, browserContext);

  const duration = (performance.now() - scraperStart) / 1000;
  logger(`scraping ended, took ${duration.toFixed(1)}s`);
  await setStatusMessage(`, took ${duration.toFixed(1)}s`, true);

  return {
    companyId: account.companyId,
    result,
  };
}

/**
 * budgetman (opt-in via `scraping.includePendingCharges`): the standard Isracard
 * scraper omits pending charges. When enabled, fetch them from the new web app
 * using the still-authenticated session and merge them into the scrape result so
 * pending FX charges (with originalAmount/originalCurrency) surface immediately.
 * Best effort — never fails the scrape.
 *
 * `actual.keepPending` is still honoured so existing configs keep working, but it
 * only governs what the Actual storage does with pending rows; whether they are
 * fetched at all is a scraping decision.
 */
async function mergeIsracardPending(
  account: AccountConfig,
  result: Awaited<ReturnType<typeof getAccountTransactions>>,
  browserContext?: BrowserContext,
): Promise<void> {
  const wantPending =
    config.options.scraping.includePendingCharges ||
    Boolean(config.storage.actual?.keepPending);

  if (
    !result.success ||
    account.companyId !== CompanyTypes.isracard ||
    !wantPending ||
    !browserContext
  ) {
    return;
  }

  try {
    const pendingByAccount =
      await fetchIsracardPendingByAccount(browserContext);
    let merged = 0;
    for (const acc of result.accounts ?? []) {
      const pending = pendingByAccount.get(acc.accountNumber);
      if (pending?.length) {
        acc.txns.unshift(...pending);
        merged += pending.length;
      }
    }
    logger(`merged ${merged} Isracard pending transaction(s)`);
  } catch (e) {
    logger(`failed to merge Isracard pending`, e);
  }
}

/**
 * budgetman card-lifecycle enrichment (#14, opt-in, default off). Fires when
 * `scraping.enrichCardChargeDates` (a scraping step, dry-runnable to localJson)
 * OR `actual.clearOnChargeDate` (production, which also clears on the date) is on.
 * Cross-account post-step: FIBI (beinleumi) holds the authoritative bank CHARGE
 * DATE (via its SUGBAKA=211 settlement drill-down) while Isracard holds the
 * merchant-named granular purchase. Using FIBI's still-authenticated session,
 * fetch each `NNNN - ישראכרט` settlement debit's drill-down and stamp the real
 * charge date onto the matching Isracard granular transaction's `processedDate`,
 * so the Actual provider clears it on the day it hit the bank. Best effort —
 * never fails the scrape. Mutates the granular transactions in the results in
 * place.
 */
async function enrichCardChargeDates(
  results: AccountScrapeResult[],
  contextByCompany: Map<CompanyTypes, BrowserContext>,
): Promise<void> {
  // Enrich when explicitly requested as a scraping step (dry-run to localJson) OR
  // when the Actual provider will clear on the charge date (production). The
  // provider's clearing stays gated on clearOnChargeDate alone (unchanged).
  const wantEnrich =
    config.options.scraping.enrichCardChargeDates ||
    Boolean(config.storage.actual?.clearOnChargeDate);
  if (!wantEnrich) return;

  const fibiContext = contextByCompany.get(CompanyTypes.beinleumi);
  if (!fibiContext) {
    logger("enrichCardChargeDates: no FIBI (beinleumi) session; skipping");
    return;
  }

  const settlementDebits: Transaction[] = [];
  const isracardGranular: Transaction[] = [];
  for (const { companyId, result } of results) {
    if (!result.success) continue;
    for (const account of result.accounts ?? []) {
      for (const tx of account.txns) {
        if (
          companyId === CompanyTypes.beinleumi &&
          isIsracardSettlementDebit(tx)
        ) {
          settlementDebits.push(tx);
        } else if (
          companyId === CompanyTypes.isracard &&
          tx.status === TransactionStatuses.Completed
        ) {
          isracardGranular.push(tx);
        }
      }
    }
  }

  if (settlementDebits.length === 0 || isracardGranular.length === 0) {
    logger(
      `enrichCardChargeDates: nothing to enrich (${settlementDebits.length} debit(s), ${isracardGranular.length} granular)`,
    );
    return;
  }

  await enrichFibiCardChargeDates(
    fibiContext,
    settlementDebits,
    isracardGranular,
  );
}
