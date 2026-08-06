import {
  type Transaction,
  TransactionStatuses,
} from "israeli-bank-scrapers/lib/transactions.js";
import { toJerusalemDate } from "../bot/storage/dates.js";

// Stale-pending age-out (budgetman, opt-in via scraping.dropStalePendingDays).
//
// Some merchants pre-authorize each purchase individually, then CAPTURE several
// bundled under a new reference (e.g. Lime pre-auths each ride, then settles
// several rides as one debit). The bundled capture doesn't reference the original
// per-item auths, so Isracard never voids them — they linger as PENDING until
// they expire (foreign / standing-order auths run for weeks), double-counting an
// item that already settled inside the bundle. A genuine pending settles within a
// few days, so a pending that is still open after a conservative threshold is
// almost certainly an orphaned auth. Dropping it is safe: if it were real and
// settles later, it simply re-appears (as its settled twin) on the next scrape.

/** Signed calendar-day gap (b − a) for `YYYY-MM-DD` strings; +Inf if unparseable. */
function calDayGap(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return Number.POSITIVE_INFINITY;
  return (db - da) / 86_400_000;
}

/**
 * Split a transaction list into the rows to keep and the stale PENDING rows to
 * drop (purchase date older than `thresholdDays` before `todayCal`). Only pending
 * rows are ever dropped — completed/settled rows are always kept. `thresholdDays`
 * <= 0 disables the filter (drops nothing). Pure; `todayCal` is injected so the
 * decision is deterministic and testable.
 */
export function dropStalePendingCharges(
  txns: Transaction[],
  thresholdDays: number,
  todayCal: string,
): { kept: Transaction[]; dropped: Transaction[] } {
  if (!(thresholdDays > 0)) return { kept: txns, dropped: [] };
  const kept: Transaction[] = [];
  const dropped: Transaction[] = [];
  for (const tx of txns) {
    const age = calDayGap(toJerusalemDate(tx.date), todayCal);
    if (tx.status === TransactionStatuses.Pending && age > thresholdDays) {
      dropped.push(tx);
    } else {
      kept.push(tx);
    }
  }
  return { kept, dropped };
}
