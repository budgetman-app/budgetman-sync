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
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// FIBI renders DD/MM/YYYY (validated live 2026-08-02); accept dots too, and a
// 2-digit year, for resilience.
const DATE_RE = /(\d{2})[./](\d{2})[./](\d{2,4})/;
// A signed ILS amount like "28.00" / "1,234.56" / "-15.00".
const AMOUNT_RE = /-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/;

// The validated header labels (in column order). We locate the data table by
// these rather than by position, because the table sits among page-chrome rows.
const HEADER_PURCHASE = "תאריך עסקה";
const HEADER_CHARGE = "תאריך חיוב";
const HEADER_MERCHANT = "שם העסק";

function parseAmount(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

function cellsOf(rowHtml: string): string[] {
  return (rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(stripTags);
}

/**
 * Parse the FIBI SUGBAKA=211 drill-down HTML into itemised expenses.
 *
 * Validated live (2026-08-02, docs/card-lifecycle-design.md). The data table has
 * this exact header + column order:
 *   תאריך עסקה | תאריך חיוב | שם העסק | סכום עסקה | סכום חיוב | פירוט
 * Data rows: purchaseDate(DD/MM/YYYY) | chargeDate(DD/MM/YYYY) | merchant |
 *            dealAmount | chargeAmount | (empty detail cell).
 * A settlement with N purchases yields N data rows.
 *
 * The table is embedded among page-chrome rows, so we anchor on the Hebrew
 * header labels: parse only rows AFTER the header row, and only those with the
 * expected shape (two dates + merchant + a charge amount). Chrome rows lack that
 * shape and are ignored.
 */
export function parseFibiCardExpenses(html: string): FibiCardExpense[] {
  const expenses: FibiCardExpense[] = [];
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];

  // Anchor: find the header row carrying the validated labels.
  const headerIdx = rowMatches.findIndex((r) => {
    const text = stripTags(r);
    return (
      text.includes(HEADER_PURCHASE) &&
      text.includes(HEADER_CHARGE) &&
      text.includes(HEADER_MERCHANT)
    );
  });

  // If the header is present, parse only rows after it; otherwise fall back to
  // shape-based scanning of every row (still safe — the shape check is strict).
  const dataRows =
    headerIdx === -1 ? rowMatches : rowMatches.slice(headerIdx + 1);

  for (const rowHtml of dataRows) {
    const cells = cellsOf(rowHtml);
    if (cells.length < 5) continue;

    // Columns (validated): purchase date | charge date | merchant |
    // deal amount | charge amount | (detail).
    const [purchaseCell, chargeCell, merchantCell, dealCell, chargeAmtCell] =
      cells;

    const purchaseDate = DATE_RE.exec(purchaseCell)?.[0];
    const chargeDate = DATE_RE.exec(chargeCell)?.[0];
    const dealMatch = AMOUNT_RE.exec(dealCell)?.[0];
    const chargeMatch = AMOUNT_RE.exec(chargeAmtCell)?.[0];
    const merchant = merchantCell.trim();

    if (!purchaseDate || !chargeDate || !merchant || !chargeMatch) continue;
    // A merchant column that is itself a date/amount means we mis-aligned on a
    // chrome row — skip.
    if (DATE_RE.test(merchant)) continue;

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

/** One settlement debit's drill-down result: the itemised ILS expenses behind
 * it. FX charges are NOT itemised here (they sit in a separate, non-tabular
 * "עסקאות במט"ח" section), so a batch's FX total is recovered as the RESIDUAL:
 * |debit total| − Σ(these ILS expenses). See `matchFxResidualsToGranular`. */
export interface FibiSettlementDrilldown {
  ref: FibiSettlementRef;
  expenses: FibiCardExpense[];
}

/**
 * Fetch + parse the itemised card expenses for a set of settlement debits,
 * reusing the already authenticated FIBI browser context. Read-only, best
 * effort: on any failure it logs and returns what it has, so the standard import
 * is unaffected. Returns one entry PER input ref (in order, empty on failure) so
 * the caller can pair each batch's ILS rows with that debit's own total to
 * recover the FX residual; see `cardChargeDates.ts`.
 *
 * NOTE: the drill-down HTML is validated (2026-08-02); the live session hookup
 * and the `I-SEL-MS-KARTIS` ref construction still need an owner-gated dry-run
 * (see docs/impl-notes-card-lifecycle.md).
 */
export async function fetchFibiCardExpenses(
  browserContext: BrowserContext,
  settlements: FibiSettlementRef[],
): Promise<FibiSettlementDrilldown[]> {
  const out: FibiSettlementDrilldown[] = [];
  let page;
  try {
    page = await browserContext.newPage();
    for (const ref of settlements) {
      const url = buildFibiCardExpensesUrl(ref);
      let expenses: FibiCardExpense[] = [];
      try {
        const resp = await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: 60_000,
        });
        const html = (await resp?.text()) ?? "";
        expenses = parseFibiCardExpenses(html);
        logger(
          `parsed ${expenses.length} expense(s) for settlement ${ref.cardStatementRef} @ ${ref.chargeDate}`,
        );
      } catch (e) {
        logger(`failed to fetch settlement ${ref.cardStatementRef}`, e);
      }
      out.push({ ref, expenses });
    }
  } catch (e) {
    logger("failed to open FIBI card-expenses page", e);
  } finally {
    await page?.close().catch(() => {});
  }
  return out;
}
