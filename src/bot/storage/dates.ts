// TZ-safe calendar-date formatting for the Actual provider (budgetman).
//
// The bank stamps transactions in Israel time. FIBI in particular stamps at
// 21:00 UTC, which is 00:00 in Asia/Jerusalem — so formatting the calendar date
// from a UTC (or machine-local) clock shifts the date by a day and, because the
// date is part of the transaction hash, duplicates every row on a UTC host.
// (This actually happened — see docs/impl-notes-card-lifecycle.md.)
//
// Any date->YYYY-MM-DD conversion on the new opt-in code paths MUST go through
// here so the calendar date is always the Israeli one, regardless of host TZ.

export const JERUSALEM_TZ = "Asia/Jerusalem";

const jerusalemFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: JERUSALEM_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Format an ISO date string (or Date) as the `YYYY-MM-DD` calendar date in
 * Asia/Jerusalem. `en-CA` renders ISO-style `YYYY-MM-DD`.
 */
export function toJerusalemDate(iso: string | Date): string {
  return jerusalemFormatter.format(new Date(iso));
}
