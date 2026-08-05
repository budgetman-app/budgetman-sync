import { hash } from "hash-it";

// Stable-key pending/FX upsert planner (budgetman, opt-in).
//
// Pure and side-effect-free so it can be unit-tested without an Actual server.
// The provider (actual.ts) fetches existing rows, calls planActualUpsert, then
// applies the returned adds/updates via the Actual API.
//
// The core idea: a foreign charge's `originalAmount + originalCurrency` is
// invariant pending->settled (only the ILS estimate moves and the voucher is
// assigned late). So a pending row and its settled twin share a stable "base
// key" used as the pending row's imported_id. On settle we find that twin and
// update it in place — new amount, cleared, upgraded imported_id, a change note
// — WITHOUT ever touching its category.
//
// Drift tolerance (non-card path): FIBI mutates a pending row's DATE (e.g. a
// reserve credit re-stamped 08-02 -> 08-03) and its DESCRIPTION (e.g. a settled
// row reading "081מופ\"ת מילואי" vs the pending "081 מופ\"ת מילואים"). Baking
// either into the key spawns a duplicate every scrape. So the non-card key
// (`computeStableKey`) is a date/description-INDEPENDENT signature
// (|originalAmount| + originalCurrency + account), and the planner matches a
// twin within a small DATE WINDOW (+/-DRIFT_WINDOW_DAYS). The card path
// (`computeCardKey`) and legacy exact keys are unchanged.

/** Minimal shape of an existing Actual transaction the planner reasons about. */
export interface ExistingActualTx {
  id: string;
  imported_id: string | null;
  amount: number; // integer minor units (Actual convention)
  cleared: boolean;
  notes: string | null;
  /** YYYY-MM-DD. Used to window-match a signature-keyed twin across date drift. */
  date?: string;
}

/** A scraped transaction normalized for planning. Amounts are integer minor units. */
export interface IncomingTx {
  /**
   * Signature base key shared by a pending charge and its settled twin:
   * `pend:sig_<hash(|originalAmount|, originalCurrency, account)>` (non-card),
   * `pend:card_<date>_<amount>` (card). Also the pending row's imported_id.
   */
  baseKey: string;
  /** imported_id to use once settled (moneyman's uniqueId/voucher-based hash). */
  settledImportedId: string;
  isPending: boolean;
  amount: number;
  date: string; // YYYY-MM-DD — the Actual row date
  /**
   * YYYY-MM-DD used to window-match a signature-keyed twin (the purchase/key
   * date). Distinct from `date`, which for a settled card row is the later bank
   * charge date. Defaults to `date` when omitted.
   */
  matchDate?: string;
  payeeName: string;
  notes: string;
}

export interface PlannedAdd {
  imported_id: string;
  date: string;
  amount: number;
  payee_name: string;
  cleared: boolean;
  notes: string;
}

export interface PlannedUpdate {
  id: string;
  /** Fields to change. `category` is intentionally never present. */
  fields: {
    amount?: number;
    cleared?: boolean;
    imported_id?: string;
    notes?: string;
    /**
     * Only present when `updateDateOnSettle` is on (card-lifecycle #14): moves a
     * settled card row from its pending purchase date to the real bank charge
     * date so cleared rows line up with FIBI's posted running balance.
     */
    date?: string;
  };
}

export interface UpsertPlan {
  adds: PlannedAdd[];
  updates: PlannedUpdate[];
  /** Human-readable change lines (new / finalized-with-delta / pending). */
  report: string[];
}

export const PENDING_NOTE = "PENDING";

/** Pending<->settled twin match window: FIBI drifts the pending date by a day
 * or two before it settles; a genuinely different transaction sharing the same
 * amount signature is expected to be further apart than this. */
export const DRIFT_WINDOW_DAYS = 4;

/**
 * The non-card, drift-tolerant base key shared by a pending charge and its
 * settled twin. Deliberately a DATE- and DESCRIPTION-independent signature:
 * signed `originalAmount` (in minor units) + `originalCurrency` + `account`.
 * This survives FIBI re-stamping the pending date or reporting a slightly
 * different description on settle (both re-duplicated in production). It keys on
 * `originalAmount` — the FX-invariant — never the ILS `chargedAmount` (which
 * moves) or the late-assigned `identifier`. The SIGN is kept: a charge keeps its
 * sign through settlement, so signed is stable for the collapse, and it prevents
 * a +890 credit and a −890 debit (same currency+account within the window) from
 * wrongly collapsing — a real collision given the recurring +890 reserve credit.
 * The planner pairs it with a date window so two genuinely distinct same-amount
 * transactions weeks apart do not over-collapse. Trade-off: two DIFFERENT
 * non-card transactions with the exact same signed amount+currency+account
 * WITHIN the window collapse into one; for non-card FIBI activity
 * (salary/government/bills) exact-agora collisions in a 4-day window are rare.
 * Card purchases take `computeCardKey`, not this.
 */
export function computeStableKey(fields: {
  originalAmount: number;
  originalCurrency: string;
  account: string;
}): string {
  const parts = [
    Math.round(fields.originalAmount * 100),
    fields.originalCurrency,
    fields.account,
  ];
  return `pend:sig_${hash(parts.map((p) => String(p ?? "").trim()).join("_")).toString()}`;
}

/**
 * A base key shared by a domestic (ILS) card charge's two views: the bank's
 * per-purchase pending authorization (e.g. FIBI "דירקט אושר-ישראכרט", immediate,
 * no merchant) and the card issuer's settled granular row (e.g. Isracard, with
 * merchant, arriving a day or two later). They share only amount + purchase date
 * — description and source account differ — so the FX stable key cannot match
 * them. Unlike the FX key this uses `chargedAmount`, which for a domestic charge
 * does not move between authorization and settlement.
 */
export function computeCardKey(fields: {
  date: string; // YYYY-MM-DD
  amountMinor: number; // integer minor units (sign-insensitive)
}): string {
  return `pend:card_${fields.date}_${Math.abs(fields.amountMinor)}`;
}

function ils(minorUnits: number): string {
  // Change notes read as magnitudes (charges are stored negative).
  return (Math.abs(minorUnits) / 100).toFixed(2);
}

function slotImportedId(baseKey: string, slot: number): string {
  // Disambiguate same-day identical-amount charges (same base key).
  return slot === 0 ? baseKey : `${baseKey}#${slot}`;
}

function baseOf(importedId: string): string | null {
  if (!importedId.startsWith("pend:")) return null;
  const hashIdx = importedId.indexOf("#");
  return hashIdx === -1 ? importedId : importedId.slice(0, hashIdx);
}

/** Signature (drift-tolerant) keys window-match by date; card/legacy keys are
 * matched exactly, as before. */
function isSignatureKey(base: string): boolean {
  return base.startsWith("pend:sig_");
}

/** Whole-day distance between two YYYY-MM-DD dates. Unknown dates are treated as
 * in-window (0) — only the signature path consults dates, and the provider
 * always supplies them. */
function daysApart(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.abs(da - db) / 86_400_000;
}

/**
 * Decide what to add and what to update in Actual for a single account.
 * Idempotent: re-running with the same inputs produces no changes once settled.
 */
export interface PlanOptions {
  /**
   * When settling a pending twin in place, also move its date to the settled
   * row's date (the real bank charge date). Off by default so the FX/pending
   * upsert path is byte-for-byte unchanged; the provider turns it on only under
   * `actual.clearOnChargeDate`. New settled rows (no pending twin) always carry
   * their own date via the add path, independent of this flag.
   */
  updateDateOnSettle?: boolean;
}

export function planActualUpsert(
  incoming: IncomingTx[],
  existing: ExistingActualTx[],
  options: PlanOptions = {},
): UpsertPlan {
  const adds: PlannedAdd[] = [];
  const updates: PlannedUpdate[] = [];
  const report: string[] = [];

  const byImportedId = new Map<string, ExistingActualTx>();
  const pendingByBase = new Map<string, ExistingActualTx[]>();
  for (const e of existing) {
    if (!e.imported_id) continue;
    byImportedId.set(e.imported_id, e);
    const base = baseOf(e.imported_id);
    if (base) {
      const list = pendingByBase.get(base) ?? [];
      list.push(e);
      pendingByBase.set(base, list);
    }
  }

  const consumed = new Set<string>(); // existing ids already matched this run
  const usedNewIds = new Set<string>(); // imported_ids minted for adds this run

  const matchDateOf = (tx: IncomingTx): string => tx.matchDate ?? tx.date;

  // Find the unconsumed existing twin for a base key. Card/legacy keys match
  // exactly (as before); signature keys match the nearest row within the drift
  // window, so a re-stamped pending date still collapses onto the same row.
  const findTwin = (
    baseKey: string,
    matchDate: string,
  ): ExistingActualTx | undefined => {
    const candidates = (pendingByBase.get(baseKey) ?? []).filter(
      (e) => !consumed.has(e.id),
    );
    if (candidates.length === 0) return undefined;
    if (!isSignatureKey(baseKey)) return candidates[0];
    let best: ExistingActualTx | undefined;
    let bestDelta = Infinity;
    for (const e of candidates) {
      const delta = daysApart(e.date, matchDate);
      if (delta <= DRIFT_WINDOW_DAYS && delta < bestDelta) {
        best = e;
        bestDelta = delta;
      }
    }
    return best;
  };

  // Pick a free imported_id for a new pending add, avoiding collision with an
  // existing row OR another add this run that shares the base key (two genuinely
  // distinct same-signature transactions out of window must coexist).
  const allocImportedId = (baseKey: string): string => {
    let slot = 0;
    let id = slotImportedId(baseKey, slot);
    while (byImportedId.has(id) || usedNewIds.has(id)) {
      slot++;
      id = slotImportedId(baseKey, slot);
    }
    usedNewIds.add(id);
    return id;
  };

  // When a settled row and pending rows share a base key in the SAME batch, the
  // pending views are already superseded — keep only the settled. Without this,
  // once a card charge settles the pending authorization (still present in the
  // same scrape) would re-add a duplicate placeholder alongside the settled row.
  // For signature keys the settled must also be within the drift window (two
  // distinct same-signature rows in one batch must not cancel each other).
  const settledList = incoming.filter((tx) => !tx.isPending);
  const isSuperseded = (p: IncomingTx): boolean =>
    settledList.some(
      (s) =>
        s.baseKey === p.baseKey &&
        (!isSignatureKey(p.baseKey) ||
          daysApart(matchDateOf(s), matchDateOf(p)) <= DRIFT_WINDOW_DAYS),
    );
  const planned = incoming.filter((tx) => !(tx.isPending && isSuperseded(tx)));

  for (const tx of planned) {
    const matchDate = matchDateOf(tx);
    if (tx.isPending) {
      // If this charge already exists as a settled/cleared row (imported under
      // its settledImportedId), FIBI has posted it — do NOT re-add a pending
      // duplicate if a later scrape reports it unmatched (clearOnFibiSettlement:
      // once posted it stays posted; the enrichment window may just not re-drill
      // it). Idempotent. (Relies on a stable settledImportedId for the charge.)
      if (byImportedId.has(tx.settledImportedId)) continue;
      const twin = findTwin(tx.baseKey, matchDate);
      if (twin) {
        consumed.add(twin.id);
        const fields: PlannedUpdate["fields"] = {};
        if (twin.amount !== tx.amount) {
          fields.amount = tx.amount;
          fields.notes = `${PENDING_NOTE} ₪${ils(twin.amount)}→₪${ils(tx.amount)}`;
          report.push(
            `pending updated: ${tx.payeeName} ₪${ils(twin.amount)}→₪${ils(tx.amount)}`,
          );
        }
        // Follow FIBI's pending date drift so the match window keeps tracking it
        // (signature keys only; card/legacy rows keep their exact date).
        if (
          isSignatureKey(tx.baseKey) &&
          twin.date &&
          twin.date !== matchDate
        ) {
          fields.date = matchDate;
          report.push(
            `pending re-dated: ${tx.payeeName} ${twin.date}→${matchDate}`,
          );
        }
        if (Object.keys(fields).length > 0) {
          updates.push({ id: twin.id, fields });
        }
      } else {
        adds.push({
          imported_id: allocImportedId(tx.baseKey),
          date: tx.date,
          amount: tx.amount,
          payee_name: tx.payeeName,
          cleared: false,
          notes: PENDING_NOTE,
        });
        report.push(`new pending: ${tx.payeeName} ₪${ils(tx.amount)}`);
      }
    } else {
      // settled
      const prior = byImportedId.get(tx.settledImportedId);
      if (prior) {
        // A row already exists under this settled id. If it is genuinely
        // finalized (cleared, and on the settled date when we manage dates), it
        // is a true no-op. Otherwise it was imported UNCLEARED (or on the wrong
        // date) under an id that equals this settledImportedId and got stuck —
        // finalize it IN PLACE: flip cleared (and fix the date under
        // updateDateOnSettle) without touching amount/category/notes/imported_id.
        const dateOk = !options.updateDateOnSettle || prior.date === tx.date;
        if (prior.cleared && dateOk) continue; // already correct -> no-op
        const fields: PlannedUpdate["fields"] = { cleared: true };
        if (options.updateDateOnSettle && prior.date !== tx.date) {
          fields.date = tx.date;
        }
        updates.push({ id: prior.id, fields });
        report.push(`cleared stuck row: ${tx.payeeName} ₪${ils(tx.amount)}`);
        continue;
      }
      const twin = findTwin(tx.baseKey, matchDate);
      if (twin) {
        consumed.add(twin.id);
        updates.push({
          id: twin.id,
          fields: {
            amount: tx.amount,
            cleared: true,
            imported_id: tx.settledImportedId,
            notes: `settled ₪${ils(twin.amount)}→₪${ils(tx.amount)}`,
            ...(options.updateDateOnSettle ? { date: tx.date } : {}),
          },
        });
        report.push(
          `finalized: ${tx.payeeName} ₪${ils(twin.amount)}→₪${ils(tx.amount)}`,
        );
      } else {
        adds.push({
          imported_id: tx.settledImportedId,
          date: tx.date,
          amount: tx.amount,
          payee_name: tx.payeeName,
          cleared: true,
          notes: tx.notes,
        });
        report.push(`new: ${tx.payeeName} ₪${ils(tx.amount)}`);
      }
    }
  }

  return { adds, updates, report };
}
