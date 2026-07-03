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
 * budgetman (opt-in via `actual.keepPending`): the standard Isracard scraper
 * omits pending charges. When enabled, fetch them from the new web app using the
 * still-authenticated session and merge them into the scrape result so pending
 * FX charges (with originalAmount/originalCurrency) surface immediately. Best
 * effort — never fails the scrape.
 */
async function mergeIsracardPending(
  account: AccountConfig,
  result: Awaited<ReturnType<typeof getAccountTransactions>>,
  browserContext?: BrowserContext,
): Promise<void> {
  if (
    !result.success ||
    account.companyId !== CompanyTypes.isracard ||
    !config.storage.actual?.keepPending ||
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
