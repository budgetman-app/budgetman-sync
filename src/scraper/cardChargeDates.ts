import type { BrowserContext } from "puppeteer";
import type { Transaction } from "israeli-bank-scrapers/lib/transactions.js";
import { TransactionStatuses } from "israeli-bank-scrapers/lib/transactions.js";
import { createLogger } from "../utils/logger.js";
import { toJerusalemDate } from "../bot/storage/dates.js";
import {
  fetchFibiCardExpenses,
  type FibiCardExpense,
  type FibiSettlementRef,
} from "./fibiCardExpenses.js";

const logger = createLogger("card-charge-dates");

// Card-lifecycle enrichment (#14, HYBRID): Isracard supplies the merchant NAME +
// PENDING + FX (the uncleared side); FIBI's SUGBAKA=211 settlement drill-down
// supplies the real BANK CHARGE DATE (the cleared side). israeli-bank-scrapers'
// Isracard scraper reports the monthly statement date as `processedDate`, which
// is the WRONG clock for direct debits. This module rewrites the Isracard
// granular transaction's `processedDate` to the FIBI charge date, so the Actual
// provider (under `clearOnChargeDate`) clears it on the day it actually hit the
// bank and the cleared balance reconstructs FIBI's posted running balance.
//
// All of this is opt-in (default off) and best-effort: any failure leaves the
// transactions untouched and the standard import unaffected.

/**
 * Normalize a merchant string for cross-source matching. Isracard renders the
 * same merchant inconsistently across buckets — the settlement drill-down gives
 * "LIME*2 RIDES RUUL" while the granular gives "LIME 2 RIDES RUUL" — so we fold
 * any run of punctuation/separators (`*`, `-`, etc.) to a single space, then
 * collapse whitespace, trim, and lower-case. Conservative: keeps letters
 * (incl. Hebrew) and digits; only non-alphanumeric separators are flattened.
 */
export function normalizeMerchant(name: string | undefined): string {
  return (name ?? "")
    .replace(/[^\p{L}\p{N}]+/gu, " ") // punctuation/separators -> single space
    .replace(/\s+/g, " ") // collapse remaining whitespace
    .trim()
    .toLocaleLowerCase();
}

function amountKeyMinor(n: number | undefined): number {
  return Math.round(Math.abs(Number(n ?? 0)) * 100);
}

/** Shortest common-prefix length below which a prefix match is too loose. */
const MERCHANT_PREFIX_FLOOR = 6;

/**
 * Prefix-tolerant merchant equality on two ALREADY-normalized names. Isracard
 * truncates merchant names differently across buckets — the granular gives
 * "google workspace rec", the drill-down "google workspace recov" — so exact
 * equality misses them. Since amount + purchase-date already strongly identify
 * the charge and merchant is only the tiebreak, we accept a prefix match once the
 * shorter name is at least MERCHANT_PREFIX_FLOOR chars (avoids spurious short
 * collisions like "up" vs "upapp").
 */
export function merchantsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < MERCHANT_PREFIX_FLOOR) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** `DD/MM/YYYY` or `DD.MM.YYYY` (2- or 4-digit year) -> `YYYY-MM-DD`. */
function ddmmyyyyToCalendar(s: string): string | null {
  const m = /(\d{2})[./](\d{2})[./](\d{2,4})/.exec(s ?? "");
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${mo}-${d}`;
}

/** ISO instant for a `DD/MM/YYYY` calendar date at UTC midnight. */
function ddmmyyyyToIso(s: string): string | null {
  const cal = ddmmyyyyToCalendar(s);
  if (!cal) return null;
  const [y, mo, d] = cal.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).toISOString();
}

export interface MatchResult {
  /** Number of granular transactions whose processedDate was set. */
  updated: number;
  /** Drill-down rows that found no granular twin. */
  unmatched: FibiCardExpense[];
  report: string[];
}

/**
 * Match each FIBI drill-down expense to an Isracard granular transaction and set
 * that transaction's `processedDate` to the drill-down's real bank charge date.
 *
 * Matching heuristic (chosen for cross-source robustness):
 *   normalized merchant  +  |amount| in minor units  +  purchase calendar date
 * - merchant is normalized (punctuation/whitespace folded, trimmed, lower-cased)
 *   and compared prefix-tolerantly (see `merchantsMatch`) because the two sources
 *   differ on separators AND truncate names differently;
 * - amount is compared sign-insensitively in integer minor units (both sources
 *   store ILS, so `chargeAmount` vs the granular `chargedAmount`);
 * - the purchase date is compared as an Asia/Jerusalem calendar date (TZ-safe).
 * Each granular row is consumed at most once, so an N-purchase settlement maps
 * its N drill-down rows onto N distinct granular transactions (N:1 by debit,
 * 1:1 by purchase). Mutates the matched transactions in place.
 */
export function matchChargeDatesToGranular(
  granular: Transaction[],
  expenses: FibiCardExpense[],
): MatchResult {
  const report: string[] = [];
  const unmatched: FibiCardExpense[] = [];
  const consumed = new Set<number>();
  let updated = 0;

  for (const expense of expenses) {
    const wantMerchant = normalizeMerchant(expense.merchant);
    const wantAmount = amountKeyMinor(expense.chargeAmount);
    const wantDate = ddmmyyyyToCalendar(expense.purchaseDate);
    const chargeIso = ddmmyyyyToIso(expense.chargeDate);

    const idx = granular.findIndex(
      (g, i) =>
        !consumed.has(i) &&
        amountKeyMinor(g.chargedAmount) === wantAmount &&
        toJerusalemDate(g.date) === wantDate &&
        merchantsMatch(normalizeMerchant(g.description), wantMerchant),
    );

    if (idx === -1 || !chargeIso) {
      unmatched.push(expense);
      report.push(
        `unmatched: ${expense.merchant.trim()} ₪${Math.abs(
          expense.chargeAmount,
        ).toFixed(2)} @ ${expense.purchaseDate}`,
      );
      continue;
    }

    consumed.add(idx);
    granular[idx].processedDate = chargeIso;
    // Mark it POSTED by FIBI: this granular appears in a booked settlement
    // drill-down, so under `clearOnFibiSettlement` it may clear. Unmatched
    // granular are left unmarked (they stay uncleared until FIBI posts them).
    (granular[idx] as Transaction & { bankSettled?: boolean }).bankSettled =
      true;
    updated++;
    report.push(
      `charge date set: ${expense.merchant.trim()} ${expense.purchaseDate} -> charge ${expense.chargeDate}`,
    );
  }

  return { updated, unmatched, report };
}

/**
 * Derive the drill-down request ref for a FIBI `NNNN - ישראכרט` settlement debit.
 *
 * UNVERIFIED encoding (needs the owner-gated dry-run): from the one live example
 * (`docs/card-lifecycle-design.md`) `I-SEL-MS-KARTIS` = `0` + the 4-digit card
 * number + the 7-digit zero-padded statement reference (the אסמכתא), e.g. card
 * 0041 + ref 13795 -> `000410013795`. The reference is taken from the debit's
 * `identifier`; the charge date is the debit's own date (dd.mm.yyyy). Returns
 * null when the description/identifier don't yield both parts.
 */
export function settlementRefFromDebit(
  debit: Transaction,
): FibiSettlementRef | null {
  const cardMatch = /(\d{3,4})\s*-\s*ישראכרט/.exec(debit.description ?? "");
  const card = cardMatch?.[1];
  const ref = debit.identifier == null ? "" : String(debit.identifier).trim();
  if (!card || !ref || !/^\d+$/.test(ref)) return null;

  const cardStatementRef = `0${card.padStart(4, "0")}${ref.padStart(7, "0")}`;
  const cal = toJerusalemDate(debit.date); // YYYY-MM-DD
  const [y, mo, d] = cal.split("-");
  const chargeDate = `${d}.${mo}.${y}`; // endpoint expects dd.mm.yyyy
  return { cardStatementRef, chargeDate };
}

/** A FIBI booked settlement debit for the Isracard card (aggregate `0041`). */
export function isIsracardSettlementDebit(tx: Transaction): boolean {
  return (
    tx.status === TransactionStatuses.Completed &&
    /ישראכרט/.test(tx.description ?? "") &&
    tx.identifier != null &&
    String(tx.identifier).trim() !== ""
  );
}

/**
 * Orchestrate the enrichment: for each FIBI Isracard settlement debit, fetch its
 * drill-down (via the authenticated FIBI browser context) and stamp the real
 * charge date onto the matching Isracard granular transactions. Best-effort:
 * never throws.
 */
export async function enrichFibiCardChargeDates(
  browserContext: BrowserContext,
  settlementDebits: Transaction[],
  isracardGranular: Transaction[],
): Promise<MatchResult> {
  const empty: MatchResult = { updated: 0, unmatched: [], report: [] };
  try {
    const refs = settlementDebits
      .map(settlementRefFromDebit)
      .filter((r): r is FibiSettlementRef => r !== null);
    if (refs.length === 0) {
      logger("no resolvable Isracard settlement debits; skipping enrichment");
      return empty;
    }

    const expenses = await fetchFibiCardExpenses(browserContext, refs);
    if (expenses.length === 0) {
      logger("no drill-down expenses returned; skipping enrichment");
      return empty;
    }

    const result = matchChargeDatesToGranular(isracardGranular, expenses);
    logger(
      `enriched ${result.updated} charge date(s); ${result.unmatched.length} unmatched`,
    );
    for (const line of result.report) logger(line);
    return result;
  } catch (e) {
    logger("card charge-date enrichment failed", e);
    return empty;
  }
}
