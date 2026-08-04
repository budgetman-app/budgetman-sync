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
// authorizes this app. We navigate to the app so it bootstraps the session and
// issues its own GetTransactionsList calls; we capture those REQUESTS to learn
// the per-card body template, then RE-ISSUE each with `isNextBillingDate:true`
// (the page defaults to false, for which the server returns `approvals:null` —
// the entire reason nothing was importing). A same-origin `fetch(...,
// {credentials:"include"})` from the page context returns 200 with the
// approvals, so we run it via `page.evaluate` rather than trusting the passive
// (false) response.
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

/** The GetTransactionsList request body the page sends (fields we rely on). */
interface GetTransactionsListBody {
  card4Number?: string;
  isNextBillingDate?: boolean;
  cardStatus?: number;
  billingMonth?: string;
  companyCode?: number;
  isPartner?: boolean;
  [k: string]: unknown;
}

function toIsoDate(ddmmyyyy?: string): string {
  // Isracard approvals use DD/MM/YYYY. Fall back to now if missing/unparseable.
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy ?? "");
  if (!m) return new Date().toISOString();
  const [, d, mo, y] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).toISOString();
}

/**
 * The `approvals` (pending) bucket only comes back when the request asks for the
 * next billing date; the page's default (`false`) yields `approvals:null`. This
 * flips exactly that flag, preserving `billingMonth`/`companyCode`/`card4Number`.
 */
export function withNextBilling(
  body: GetTransactionsListBody,
): GetTransactionsListBody {
  return { ...body, isNextBillingDate: true };
}

/**
 * Build the approvals request for a specific card, reusing the captured
 * template's `companyCode`/`billingMonth` (all cards on the account share the
 * billing cycle) and forcing `isNextBillingDate:true`.
 */
export function withCard(
  body: GetTransactionsListBody,
  card4Number: string,
): GetTransactionsListBody {
  return { ...withNextBilling(body), card4Number };
}

/**
 * Increment a `DD/MM/YYYY` billing month by one month (day preserved, year
 * rolls over). Used to also probe the NEXT statement, where some pending rows
 * key. Returns the input unchanged if it is not parseable.
 */
export function nextBillingMonth(billingMonth?: string): string | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(billingMonth ?? "");
  if (!m) return billingMonth;
  const [, d, mo, y] = m;
  let month = Number(mo) + 1;
  let year = Number(y);
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return `${d}/${String(month).padStart(2, "0")}/${year}`;
}

/** Safely pull the approvals rows out of a GetTransactionsList response, whether
 * `approvals` is absent, null, or populated. */
export function extractApprovals(json: unknown): ApprovalRow[] {
  const rows = (json as any)?.data?.approvals?.approvedTransactions;
  return Array.isArray(rows) ? (rows as ApprovalRow[]) : [];
}

/** Distinct-request key: one active fetch per (card, billing month, company). */
function requestKey(body: GetTransactionsListBody): string {
  return `${body.card4Number ?? ""}_${body.billingMonth ?? ""}_${body.companyCode ?? ""}`;
}

/** Dedupe an approval across cards/months/re-fetches. */
function approvalKey(row: ApprovalRow): string {
  return `${row.cardSuffix ?? ""}_${row.purchaseDate ?? ""}_${row.ilsBillingAmount ?? ""}_${row.businessName ?? ""}`;
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

/** Issues one GetTransactionsList POST and returns the parsed JSON (or null). */
export type ApprovalsFetcher = (
  url: string,
  body: GetTransactionsListBody,
) => Promise<unknown>;

/** Dedupe + group approval rows by their own `cardSuffix`, converting each to a
 * pending Transaction. */
export function groupApprovals(
  rows: ApprovalRow[],
): Map<string, Transaction[]> {
  const byAccount = new Map<string, Transaction[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const account = String(row.cardSuffix ?? "");
    if (!account) continue;
    const key = approvalKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byAccount.get(account) ?? [];
    list.push(convertApprovalToTransaction(row));
    byAccount.set(account, list);
  }
  return byAccount;
}

/**
 * Enumerate pending approvals across EVERY card, re-issuing one captured request
 * template per card with `isNextBillingDate:true` (all cards share the billing
 * cycle). For a card with no rows in the current statement, also probe the next
 * billing month. Pure over an injected `fetch` so it is unit-testable without a
 * browser. Falls back to the template's own card when `cards` is empty.
 */
export async function collectApprovalsByCard(params: {
  template: { url: string; body: GetTransactionsListBody };
  cards: string[] | undefined;
  fetch: ApprovalsFetcher;
}): Promise<Map<string, Transaction[]>> {
  const { template, cards, fetch } = params;
  const targets =
    cards && cards.length > 0
      ? Array.from(new Set(cards.map((c) => String(c).trim()).filter(Boolean)))
      : [String(template.body.card4Number ?? "")].filter(Boolean);

  const all: ApprovalRow[] = [];
  for (const card of targets) {
    let rows = extractApprovals(
      await fetch(template.url, withCard(template.body, card)),
    );
    if (rows.length === 0) {
      const next = nextBillingMonth(template.body.billingMonth);
      if (next && next !== template.body.billingMonth) {
        rows = extractApprovals(
          await fetch(template.url, {
            ...withCard(template.body, card),
            billingMonth: next,
          }),
        );
      }
    }
    all.push(...rows);
  }
  return groupApprovals(all);
}

/**
 * Fetch Isracard pending (not-yet-settled) charges, reusing the already
 * authenticated browser context from the completed scrape. Read-only. Returns
 * pending transactions grouped by card suffix (== the scraper's accountNumber).
 * Never throws: on any failure it logs and returns an empty map so the settled
 * import is unaffected.
 *
 * The SPA only loads its PRIMARY card on navigation, so passively intercepting
 * its request captures just one card's template. `cards` (the account's card
 * suffixes, from the settled scrape) lets us re-issue that template per card —
 * every card shares the billing cycle — which is what surfaces the pending rows
 * on the non-primary cards. When `cards` is empty we fall back to the captured
 * template's own card.
 */
export async function fetchIsracardPendingByAccount(
  browserContext: BrowserContext,
  cards?: string[],
): Promise<Map<string, Transaction[]>> {
  let byAccount = new Map<string, Transaction[]>();
  let page;

  try {
    page = await browserContext.newPage();

    // Capture the page's own GetTransactionsList REQUEST body (the per-card
    // template — companyCode + billing month), and its FIRST response as a
    // passive fallback.
    const requests: Array<{ url: string; body: GetTransactionsListBody }> = [];
    const seenReq = new Set<string>();
    let passiveBody: string | null = null;

    page.on("request", (req) => {
      try {
        if (req.method() !== "POST" || !LIST_MATCH.test(req.url())) return;
        const raw = req.postData();
        if (!raw) return;
        const body = JSON.parse(raw) as GetTransactionsListBody;
        const key = requestKey(body);
        if (seenReq.has(key)) return;
        seenReq.add(key);
        requests.push({ url: req.url(), body });
      } catch {
        /* non-JSON body; ignore */
      }
    });
    page.on("response", async (resp) => {
      if (passiveBody || resp.status() !== 200 || !LIST_MATCH.test(resp.url()))
        return;
      try {
        passiveBody = await resp.text();
      } catch {
        /* response body unavailable; ignore */
      }
    });

    await page.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60_000 });

    // Wait until the page has issued at least one list request (or a response).
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    while (requests.length === 0 && !passiveBody && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (requests.length === 0 && !passiveBody) {
      logger("no GetTransactionsList activity captured; skipping pending");
      return byAccount;
    }

    // Issue one approvals fetch from the page context (cookies via credentials).
    const pageFetch: ApprovalsFetcher = (url, body) =>
      page!
        .evaluate(
          async (u: string, b: unknown) => {
            try {
              const r = await fetch(u, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(b),
              });
              if (!r.ok) return null;
              return await r.json();
            } catch {
              return null;
            }
          },
          url,
          body,
        )
        .catch(() => null);

    // Active path: reuse the captured template to query EVERY card (the SPA only
    // loaded its primary card, but all cards share the billing cycle).
    const template = requests[0];
    if (template) {
      byAccount = await collectApprovalsByCard({
        template,
        cards,
        fetch: pageFetch,
      });
    }

    // Fallback: if the active path yielded nothing, use the passively captured
    // response (may be the isNextBillingDate:false one, hence possibly empty).
    const total = () =>
      Array.from(byAccount.values()).reduce((n, l) => n + l.length, 0);
    if (total() === 0 && passiveBody) {
      try {
        byAccount = groupApprovals(extractApprovals(JSON.parse(passiveBody)));
      } catch {
        /* unparseable; ignore */
      }
    }

    const queried = cards && cards.length > 0 ? cards.length : requests.length;
    logger(
      `fetched ${total()} pending charge(s) across ${byAccount.size} card(s) ` +
        `(queried ${queried} card(s) from ${requests.length} template(s))`,
    );
  } catch (e) {
    logger("failed to fetch Isracard pending", e);
  } finally {
    await page?.close().catch(() => {});
  }
  return byAccount;
}
