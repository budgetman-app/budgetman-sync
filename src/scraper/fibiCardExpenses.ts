import type { BrowserContext } from "puppeteer";
import {
  type Transaction,
  TransactionStatuses,
  TransactionTypes,
} from "israeli-bank-scrapers/lib/transactions.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("fibi-card-expenses");

// FIBI (Beinleumi) settlement drill-down (#14). The standard beinleumi scraper
// imports the aggregate `0041 - ישראכרט` debit but NOT the per-merchant card
// expenses behind it, and israeli-bank-scrapers' Isracard scraper reports the
// monthly statement date rather than the real bank charge date (see
// docs/impl-notes-card-lifecycle.md). This module drives the already
// authenticated FIBI puppeteer session to fetch, per settlement debit, the
// itemised expenses WITH the real charge date — the authoritative source that
// reconstructs FIBI's posted running balance line-for-line.
//
// STATUS: parser + URL builder are implemented and unit-tested against a saved
// fixture. The live fetch (`fetchFibiCardExpenses`) is UNVERIFIED against a real
// session — the fixture HTML is a best-effort reconstruction of the Mataf
// servlet response and MUST be re-validated with an owner-gated live capture
// before this is wired into the scrape flow. Nothing here runs unless called.

const SERVLET_URL =
  "https://online.fibi.co.il/MatafServiceServlets/MatafPortalServiceServlet";

/** One settlement debit to drill into (from an Actual/FIBI `0041` debit row). */
export interface FibiSettlementRef {
  /** `I-SEL-MS-KARTIS`: card prefix + statement reference, e.g. "000410013795". */
  cardStatementRef: string;
  /** `I-TR-CHIYUV`: the debit's charge date, dd.mm.yyyy. */
  chargeDate: string;
}

/** A single itemised card expense parsed out of the drill-down HTML. */
export interface FibiCardExpense {
  /** `תאריך עסקה` — purchase date, dd.mm.yyyy as shown. */
  purchaseDate: string;
  /** `תאריך חיוב` — real bank charge date, dd.mm.yyyy as shown. */
  chargeDate: string;
  /** `שם העסק` — merchant name. */
  merchant: string;
  /** `סכום עסקה` — deal amount (original), positive magnitude. */
  dealAmount: number;
  /** `סכום חיוב` — charged amount (ILS), positive magnitude. */
  chargeAmount: number;
}

/**
 * Build the drill-down request URL for one settlement debit. Endpoint + params
 * per docs/card-lifecycle-design.md (SUGBAKA=211, I-D-STATUS=CH-KAROV).
 */
export function buildFibiCardExpensesUrl(ref: FibiSettlementRef): string {
  const url = new URL(SERVLET_URL);
  url.searchParams.set("ajaxAction", "ajax");
  url.searchParams.set("xslKey", "ajax");
  url.searchParams.set("fileType", "html");
  url.searchParams.set("SUGBAKA", "211");
  url.searchParams.set("I-SEL-MS-KARTIS", ref.cardStatementRef);
  url.searchParams.set("I-TR-CHIYUV", ref.chargeDate);
  url.searchParams.set("I-D-STATUS", "CH-KAROV");
  url.searchParams.set("B_SUGBAKA", "077");
  return url.toString();
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// dd.mm.yyyy or dd/mm/yyyy (FIBI uses dots; be lenient).
const DATE_RE = /(\d{2})[./](\d{2})[./](\d{2,4})/;
// A signed ILS amount like "28.00" / "1,234.56" / "-15.00".
const AMOUNT_RE = /-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/;

function parseAmount(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/**
 * Parse the drill-down HTML table into itemised expenses. Tolerant by design:
 * it scans table rows, and accepts any row exposing two dates (purchase, charge)
 * + a merchant + two amounts. Header/footer rows without that shape are skipped.
 *
 * The exact column order is asserted by the fixture test; if a live capture
 * shows a different layout, update the fixture and this mapping together.
 */
export function parseFibiCardExpenses(html: string): FibiCardExpense[] {
  const expenses: FibiCardExpense[] = [];
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];

  for (const rowHtml of rowMatches) {
    const cells = (rowHtml.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(stripTags);
    if (cells.length < 5) continue;

    // Columns (per the design doc): purchase date | charge date | merchant |
    // deal amount | charge amount.
    const [purchaseCell, chargeCell, merchantCell, dealCell, chargeAmtCell] =
      cells;

    const purchaseDate = DATE_RE.exec(purchaseCell)?.[0];
    const chargeDate = DATE_RE.exec(chargeCell)?.[0];
    const dealMatch = AMOUNT_RE.exec(dealCell)?.[0];
    const chargeMatch = AMOUNT_RE.exec(chargeAmtCell)?.[0];
    const merchant = merchantCell.trim();

    if (!purchaseDate || !chargeDate || !merchant || !chargeMatch) continue;

    expenses.push({
      purchaseDate,
      chargeDate,
      merchant,
      dealAmount: dealMatch ? parseAmount(dealMatch) : parseAmount(chargeMatch),
      chargeAmount: parseAmount(chargeMatch),
    });
  }

  return expenses;
}

function toIsoDate(ddmmyyyy: string): string {
  // FIBI shows dd.mm.yyyy (2- or 4-digit year). Emit UTC midnight for the
  // calendar day; downstream date formatting is TZ-safe (Asia/Jerusalem), so a
  // UTC-midnight calendar date maps back to the same Israeli day.
  const m = DATE_RE.exec(ddmmyyyy);
  if (!m) return new Date().toISOString();
  const [, d, mo, y] = m;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  return new Date(Date.UTC(year, Number(mo) - 1, Number(d))).toISOString();
}

/**
 * Map a parsed expense to a scraper Transaction. `date` = purchase date (the
 * stable-key anchor, shared with the Isracard pending twin); `processedDate` =
 * the real bank charge date, which the Actual provider clears on under
 * `actual.clearOnChargeDate`. Charges reduce the balance (negative).
 * `identifier` is intentionally left undefined — the pending<->settled match is
 * by the FX-stable key (merchant + originalAmount + date), not the voucher.
 */
export function convertFibiExpenseToTransaction(
  expense: FibiCardExpense,
): Transaction {
  return {
    type: TransactionTypes.Normal,
    identifier: undefined,
    date: toIsoDate(expense.purchaseDate),
    processedDate: toIsoDate(expense.chargeDate),
    originalAmount: -Math.abs(expense.dealAmount),
    originalCurrency: "ILS",
    chargedAmount: -Math.abs(expense.chargeAmount),
    chargedCurrency: "ILS",
    description: expense.merchant,
    status: TransactionStatuses.Completed,
    memo: "",
  };
}

/**
 * Fetch + parse the itemised card expenses for a set of settlement debits,
 * reusing the already authenticated FIBI browser context. Read-only, best
 * effort: on any failure it logs and returns what it has, so the standard import
 * is unaffected.
 *
 * NOTE: unverified against a live session (owner-gated). Not wired into the
 * scrape flow yet — call it explicitly once the response shape is confirmed.
 */
export async function fetchFibiCardExpenses(
  browserContext: BrowserContext,
  settlements: FibiSettlementRef[],
): Promise<Transaction[]> {
  const out: Transaction[] = [];
  let page;
  try {
    page = await browserContext.newPage();
    for (const ref of settlements) {
      const url = buildFibiCardExpensesUrl(ref);
      try {
        const resp = await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: 60_000,
        });
        const html = (await resp?.text()) ?? "";
        const expenses = parseFibiCardExpenses(html);
        for (const e of expenses) {
          out.push(convertFibiExpenseToTransaction(e));
        }
        logger(
          `parsed ${expenses.length} expense(s) for settlement ${ref.cardStatementRef} @ ${ref.chargeDate}`,
        );
      } catch (e) {
        logger(`failed to fetch settlement ${ref.cardStatementRef}`, e);
      }
    }
  } catch (e) {
    logger("failed to open FIBI card-expenses page", e);
  } finally {
    await page?.close().catch(() => {});
  }
  return out;
}
