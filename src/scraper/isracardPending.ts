import type { BrowserContext } from "puppeteer";
import {
  type Transaction,
  TransactionStatuses,
  TransactionTypes,
} from "israeli-bank-scrapers/lib/transactions.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("isracard-pending");

// The new Isracard web app (DigitalV3) renders the "not yet settled" (approvals)
// charges that the standard scraper omits. The legacy `performLogonI` session
// authorizes this app, but a direct fetch of the endpoint is rejected (the app
// adds request headers cookies alone don't carry) — so we navigate to the app,
// let it run its own GetTransactionsList call, and intercept the response.
const APP_URL = "https://web.isracard.co.il/transactions";
const LIST_MATCH =
  /\/ocp\/transactions\/DigitalV3\.Transactions\/GetTransactionsList/i;
const CAPTURE_TIMEOUT_MS = 30_000;

interface ApprovalRow {
  purchaseDate?: string;
  businessName?: string;
  transactionDescription?: string;
  originalAmount?: number;
  currencyIso?: string;
  ilsBillingAmount?: number;
  creditOrCharge?: number;
  cardSuffix?: string;
  seqConfirmationNumber?: string;
}

function toIsoDate(ddmmyyyy?: string): string {
  // Isracard approvals use DD/MM/YYYY. Fall back to now if missing/unparseable.
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy ?? "");
  if (!m) return new Date().toISOString();
  const [, d, mo, y] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).toISOString();
}

/**
 * Map one Isracard "approvals" (pending) row to a scraper Transaction. Uses
 * `currencyIso` for the currency (the raw `originalCurrency` is a numeric code).
 * `creditOrCharge === 1` is a charge (reduces balance -> negative); other values
 * are treated as credits/refunds (positive) — refine once a real refund is seen.
 * `identifier` is left undefined: pending has a `confirmationNumber`, but the
 * settled row gets a different voucher, so the pending->settled match relies on
 * the FX-stable originalAmount+originalCurrency key (see #4).
 */
export function convertApprovalToTransaction(row: ApprovalRow): Transaction {
  const sign = row.creditOrCharge === 1 ? -1 : 1;
  const date = toIsoDate(row.purchaseDate);
  return {
    type: TransactionTypes.Normal,
    identifier: undefined,
    date,
    processedDate: date,
    originalAmount: sign * Math.abs(Number(row.originalAmount ?? 0)),
    originalCurrency: row.currencyIso || "ILS",
    chargedAmount:
      sign * Math.abs(Number(row.ilsBillingAmount ?? row.originalAmount ?? 0)),
    chargedCurrency: "ILS",
    description: row.businessName || row.transactionDescription || "",
    status: TransactionStatuses.Pending,
    memo: "",
  };
}

/**
 * Fetch Isracard pending (not-yet-settled) charges, reusing the already
 * authenticated browser context from the completed scrape. Read-only. Returns
 * pending transactions grouped by card suffix (== the scraper's accountNumber).
 * Never throws: on any failure it logs and returns an empty map so the settled
 * import is unaffected.
 */
export async function fetchIsracardPendingByAccount(
  browserContext: BrowserContext,
): Promise<Map<string, Transaction[]>> {
  const byAccount = new Map<string, Transaction[]>();
  let page;
  try {
    page = await browserContext.newPage();

    let body: string | null = null;
    page.on("response", async (resp) => {
      if (body || resp.status() !== 200 || !LIST_MATCH.test(resp.url())) return;
      try {
        body = await resp.text();
      } catch {
        /* response body unavailable; ignore */
      }
    });

    await page.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60_000 });

    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    while (!body && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!body) {
      logger("no GetTransactionsList response captured; skipping pending");
      return byAccount;
    }

    const approvals: ApprovalRow[] =
      JSON.parse(body)?.data?.approvals?.approvedTransactions ?? [];
    for (const row of approvals) {
      const account = String(row.cardSuffix ?? "");
      if (!account) continue;
      const list = byAccount.get(account) ?? [];
      list.push(convertApprovalToTransaction(row));
      byAccount.set(account, list);
    }
    logger(
      `fetched ${approvals.length} pending charge(s) across ${byAccount.size} card(s)`,
    );
  } catch (e) {
    logger("failed to fetch Isracard pending", e);
  } finally {
    await page?.close().catch(() => {});
  }
  return byAccount;
}
