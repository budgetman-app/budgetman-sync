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

/** Minimal shape of an existing Actual transaction the planner reasons about. */
export interface ExistingActualTx {
  id: string;
  imported_id: string | null;
  amount: number; // integer minor units (Actual convention)
  cleared: boolean;
  notes: string | null;
}

/** A scraped transaction normalized for planning. Amounts are integer minor units. */
export interface IncomingTx {
  /** Stable across pending<->settled: pend:<hash(date, originalAmount, originalCurrency, merchant, account)>. */
  baseKey: string;
  /** imported_id to use once settled (moneyman's uniqueId/voucher-based hash). */
  settledImportedId: string;
  isPending: boolean;
  amount: number;
  date: string; // YYYY-MM-DD
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
  };
}

export interface UpsertPlan {
  adds: PlannedAdd[];
  updates: PlannedUpdate[];
  /** Human-readable change lines (new / finalized-with-delta / pending). */
  report: string[];
}

export const PENDING_NOTE = "PENDING";

/**
 * The FX-stable base key shared by a pending charge and its settled twin.
 * Deliberately excludes the ILS `chargedAmount` (which moves) and the
 * `identifier` (assigned only at settlement) — it keys on the invariant
 * `originalAmount + originalCurrency` plus purchase date, merchant, and account.
 */
export function computeStableKey(fields: {
  date: string; // YYYY-MM-DD (purchase date)
  originalAmount: number;
  originalCurrency: string;
  description: string;
  account: string;
}): string {
  const parts = [
    fields.date,
    fields.originalAmount,
    fields.originalCurrency,
    fields.description,
    fields.account,
  ];
  return `pend:${hash(parts.map((p) => String(p ?? "").trim()).join("_")).toString()}`;
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

/**
 * Decide what to add and what to update in Actual for a single account.
 * Idempotent: re-running with the same inputs produces no changes once settled.
 */
export function planActualUpsert(
  incoming: IncomingTx[],
  existing: ExistingActualTx[],
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
  const plannedSlots = new Map<string, number>(); // baseKey -> next slot for new pending

  const nextUnconsumed = (baseKey: string): ExistingActualTx | undefined =>
    (pendingByBase.get(baseKey) ?? []).find((e) => !consumed.has(e.id));

  // When a settled row and pending rows share a base key in the SAME batch, the
  // pending views are already superseded — keep only the settled. Without this,
  // once a card charge settles the pending authorization (still present in the
  // same scrape) would re-add a duplicate placeholder alongside the settled row.
  const settledKeys = new Set(
    incoming.filter((tx) => !tx.isPending).map((tx) => tx.baseKey),
  );
  const planned = incoming.filter(
    (tx) => !(tx.isPending && settledKeys.has(tx.baseKey)),
  );

  for (const tx of planned) {
    if (tx.isPending) {
      const twin = nextUnconsumed(tx.baseKey);
      if (twin) {
        consumed.add(twin.id);
        if (twin.amount !== tx.amount) {
          updates.push({
            id: twin.id,
            fields: {
              amount: tx.amount,
              notes: `${PENDING_NOTE} ₪${ils(twin.amount)}→₪${ils(tx.amount)}`,
            },
          });
          report.push(
            `pending updated: ${tx.payeeName} ₪${ils(twin.amount)}→₪${ils(tx.amount)}`,
          );
        }
      } else {
        const slot = plannedSlots.get(tx.baseKey) ?? 0;
        plannedSlots.set(tx.baseKey, slot + 1);
        adds.push({
          imported_id: slotImportedId(tx.baseKey, slot),
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
      if (byImportedId.has(tx.settledImportedId)) continue; // already imported -> no-op
      const twin = nextUnconsumed(tx.baseKey);
      if (twin) {
        consumed.add(twin.id);
        updates.push({
          id: twin.id,
          fields: {
            amount: tx.amount,
            cleared: true,
            imported_id: tx.settledImportedId,
            notes: `settled ₪${ils(twin.amount)}→₪${ils(tx.amount)}`,
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
