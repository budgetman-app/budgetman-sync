import {
  computeCardKey,
  computeStableKey,
  isPlaceholderPayee,
  planActualUpsert,
  PENDING_NOTE,
  type ExistingActualTx,
  type IncomingTx,
} from "./actualUpsert.js";

describe("computeStableKey", () => {
  const charge = {
    originalAmount: 20,
    originalCurrency: "USD",
    account: "0041",
  };

  it("is a signature independent of date and description (only amount+currency+account)", () => {
    // The key no longer bakes date/description, so FIBI re-stamping either does
    // not spawn a new key -> no duplicate.
    expect(computeStableKey(charge)).toBe(computeStableKey({ ...charge }));
    expect(computeStableKey(charge).startsWith("pend:sig_")).toBe(true);
  });

  it("keys on the SIGNED amount: +X and -X get different keys (no debit/credit collapse)", () => {
    expect(computeStableKey(charge)).not.toBe(
      computeStableKey({ ...charge, originalAmount: -20 }),
    );
  });

  it("differs when amount, currency, or account differ", () => {
    expect(computeStableKey(charge)).not.toBe(
      computeStableKey({ ...charge, originalCurrency: "EUR" }),
    );
    expect(computeStableKey(charge)).not.toBe(
      computeStableKey({ ...charge, originalAmount: 21 }),
    );
    expect(computeStableKey(charge)).not.toBe(
      computeStableKey({ ...charge, account: "9999" }),
    );
  });
});

describe("signature-key drift tolerance (non-card pending)", () => {
  // Two real production bugs this fixes: a +₪890 reserve credit re-duplicating
  // when its pending date shifted 08-02->08-03, and a +₪48 reserve credit not
  // collapsing pending->settled because FIBI reported a slightly different
  // description on settle.
  const SIG = computeStableKey({
    originalAmount: 890,
    originalCurrency: "ILS",
    account: "477872",
  });
  const sigPending = (over: Partial<IncomingTx> = {}): IncomingTx => ({
    baseKey: SIG,
    settledImportedId: "settled-890",
    isPending: true,
    amount: 89000, // +₪890 credit
    date: "2026-08-02",
    matchDate: "2026-08-02",
    payeeName: "ביטוח לאומי מיל",
    notes: "",
    ...over,
  });
  const existingSig = (
    over: Partial<ExistingActualTx> = {},
  ): ExistingActualTx => ({
    id: "e1",
    imported_id: SIG,
    amount: 89000,
    cleared: false,
    notes: PENDING_NOTE,
    date: "2026-08-02",
    ...over,
  });

  it("(a) collapses a pending credit whose date shifts 08-02 -> 08-03 into ONE row", () => {
    const plan = planActualUpsert(
      [sigPending({ date: "2026-08-03", matchDate: "2026-08-03" })],
      [existingSig()],
    );
    expect(plan.adds).toHaveLength(0); // no duplicate
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].id).toBe("e1");
    expect(plan.updates[0].fields.date).toBe("2026-08-03"); // window tracks the drift
    expect("amount" in plan.updates[0].fields).toBe(false); // amount unchanged
  });

  it("(b) collapses pending -> settled despite a mutated description", () => {
    const SIG48 = computeStableKey({
      originalAmount: 48,
      originalCurrency: "ILS",
      account: "477872",
    });
    const existing: ExistingActualTx[] = [
      {
        id: "p48",
        imported_id: SIG48,
        amount: 4800,
        cleared: false,
        notes: PENDING_NOTE,
        date: "2026-08-02",
      },
    ];
    const settledDrift: IncomingTx = {
      baseKey: SIG48, // same signature — description is NOT in the key
      settledImportedId: "s48",
      isPending: false,
      amount: 4800,
      date: "2026-08-03", // a day later, within the window
      matchDate: "2026-08-03",
      payeeName: '081מופ"ת מילואי', // differs from the pending "081 מופ"ת מילואים"
      notes: "",
    };
    const plan = planActualUpsert([settledDrift], existing);
    expect(plan.adds).toHaveLength(0); // collapses, no duplicate
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].id).toBe("p48");
    expect(plan.updates[0].fields).toMatchObject({
      cleared: true,
      imported_id: "s48",
    });
  });

  it("(c) does not over-collapse two distinct same-amount transactions weeks apart", () => {
    const existing: ExistingActualTx[] = [
      existingSig({ id: "old", date: "2026-07-10" }), // weeks before
    ];
    const plan = planActualUpsert(
      [sigPending({ date: "2026-08-02", matchDate: "2026-08-02" })],
      existing,
    );
    expect(plan.updates).toHaveLength(0); // the 07-10 row is out of window
    expect(plan.adds).toHaveLength(1); // a new, distinct pending row
    expect(plan.adds[0].imported_id).toBe(`${SIG}#1`); // coexists, no id collision
  });

  it("is idempotent: re-scraping an unchanged pending row does nothing", () => {
    const plan = planActualUpsert([sigPending()], [existingSig()]);
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
  });

  it("does NOT collapse a -890 debit onto the +890 credit within the window", () => {
    // Same currency+account+day, opposite sign: signed key keeps them distinct.
    const debitKey = computeStableKey({
      originalAmount: -890,
      originalCurrency: "ILS",
      account: "477872",
    });
    expect(debitKey).not.toBe(SIG);
    const plan = planActualUpsert(
      [
        sigPending({
          baseKey: debitKey,
          amount: -89000, // -₪890 debit, same day as the +890 credit row
          payeeName: "חיוב כלשהו",
        }),
      ],
      [existingSig()], // the +₪890 credit
    );
    expect(plan.updates).toHaveLength(0); // credit untouched
    expect(plan.adds).toHaveLength(1); // debit added as its own row
    expect(plan.adds[0].imported_id).toBe(debitKey);
  });
});

const BASE = "pend:123";
const SETTLED_ID = "settled-abc";

function pending(over: Partial<IncomingTx> = {}): IncomingTx {
  return {
    baseKey: BASE,
    settledImportedId: SETTLED_ID,
    isPending: true,
    amount: -6004, // -₪60.04
    date: "2026-07-03",
    payeeName: "UPSTASH",
    notes: "",
    ...over,
  };
}
function settled(over: Partial<IncomingTx> = {}): IncomingTx {
  return { ...pending(over), isPending: false, ...over };
}
function existingPending(
  over: Partial<ExistingActualTx> = {},
): ExistingActualTx {
  return {
    id: "row1",
    imported_id: BASE,
    amount: -6004,
    cleared: false,
    notes: PENDING_NOTE,
    ...over,
  };
}

describe("planActualUpsert", () => {
  it("adds a new pending charge as uncleared with the base key", () => {
    const { adds, updates } = planActualUpsert([pending()], []);
    expect(updates).toHaveLength(0);
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({
      imported_id: BASE,
      amount: -6004,
      cleared: false,
      notes: "", // owner-only field — sync writes empty
      payee_name: "UPSTASH",
    });
  });

  it("settles a pending twin in place: no duplicate, upgraded id, notes untouched", () => {
    const existing = [existingPending({ amount: -29500 })]; // pending estimate ₪295.00
    const { adds, updates } = planActualUpsert(
      [settled({ amount: -29644 })], // final ₪296.44
      existing,
    );
    expect(adds).toHaveLength(0); // never a duplicate
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("row1");
    expect(updates[0].fields).toEqual({
      amount: -29644,
      cleared: true,
      imported_id: SETTLED_ID,
    });
    expect("notes" in updates[0].fields).toBe(false); // never overwrites owner notes
  });

  it("preserves the owner's own note through a settle (never in the update)", () => {
    const existing = [
      existingPending({ amount: -29500, notes: "my receipt #42" }),
    ];
    const { updates } = planActualUpsert(
      [settled({ amount: -29644 })],
      existing,
    );
    expect(updates).toHaveLength(1);
    expect("notes" in updates[0].fields).toBe(false); // owner's "my receipt #42" untouched
    // category is never part of an update
    expect("category" in updates[0].fields).toBe(false);
  });

  it("is idempotent once settled (settled id already present)", () => {
    const existing = [
      {
        id: "row1",
        imported_id: SETTLED_ID,
        amount: -29644,
        cleared: true,
        notes: "",
      },
    ];
    const { adds, updates } = planActualUpsert(
      [settled({ amount: -29644 })],
      existing,
    );
    expect(adds).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("(stuck-row a) finalizes a row imported UNCLEARED under the settled id: cleared+date only", () => {
    // A card charge imported uncleared under an id that equals its later
    // settledImportedId used to hit `continue` forever and never clear.
    const existing = [
      {
        id: "r",
        imported_id: SETTLED_ID,
        amount: -5131,
        cleared: false,
        notes: "keep me",
        date: "2026-08-20", // future monthly placeholder it got stuck on
      },
    ];
    const { adds, updates } = planActualUpsert(
      [settled({ amount: -5131, date: "2026-08-04" })], // real charge date
      existing,
      { updateDateOnSettle: true },
    );
    expect(adds).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("r");
    expect(updates[0].fields).toEqual({ cleared: true, date: "2026-08-04" });
    // amount/notes/imported_id/category are left untouched
    expect("amount" in updates[0].fields).toBe(false);
    expect("notes" in updates[0].fields).toBe(false);
    expect("imported_id" in updates[0].fields).toBe(false);
    expect("category" in updates[0].fields).toBe(false);
  });

  it("(stuck-row b) no-op once the row is cleared and on the charge date", () => {
    const existing = [
      {
        id: "r",
        imported_id: SETTLED_ID,
        amount: -5131,
        cleared: true,
        notes: "",
        date: "2026-08-04",
      },
    ];
    const { adds, updates } = planActualUpsert(
      [settled({ amount: -5131, date: "2026-08-04" })],
      existing,
      { updateDateOnSettle: true },
    );
    expect(adds).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("(stuck-row c) clears but does NOT move the date when updateDateOnSettle is off", () => {
    const existing = [
      {
        id: "r",
        imported_id: SETTLED_ID,
        amount: -5131,
        cleared: false,
        notes: "",
        date: "2026-08-20",
      },
    ];
    const { adds, updates } = planActualUpsert(
      [settled({ amount: -5131, date: "2026-08-04" })],
      existing,
    );
    expect(adds).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].fields).toEqual({ cleared: true });
    expect("date" in updates[0].fields).toBe(false);
  });

  it("(stuck-row d) unchanged when no row has that settled id (still matches a pending twin)", () => {
    const existing = [existingPending({ amount: -5131 })]; // imported_id BASE, not SETTLED_ID
    const { adds, updates } = planActualUpsert(
      [settled({ amount: -5131 })],
      existing,
    );
    expect(adds).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("row1");
    expect(updates[0].fields).toMatchObject({
      cleared: true,
      imported_id: SETTLED_ID,
    });
  });

  it("does nothing when a pending charge re-appears unchanged", () => {
    const { adds, updates } = planActualUpsert(
      [pending({ amount: -6004 })],
      [existingPending({ amount: -6004 })],
    );
    expect(adds).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("updates a pending charge whose estimate changed (amount only, no note)", () => {
    const { adds, updates } = planActualUpsert(
      [pending({ amount: -6100 })],
      [existingPending({ amount: -6004 })],
    );
    expect(adds).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].fields).toEqual({ amount: -6100 });
    expect("notes" in updates[0].fields).toBe(false); // owner-only field
    expect(updates[0].fields.cleared).toBeUndefined();
  });

  it("adds a settled charge that never had a pending twin", () => {
    const { adds, updates } = planActualUpsert(
      [settled({ amount: -5000 })],
      [],
    );
    expect(updates).toHaveLength(0);
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({
      imported_id: SETTLED_ID,
      cleared: true,
    });
  });

  it("disambiguates two identical same-day charges (base-key collision)", () => {
    // two ₪19 charges, same merchant/day/currency -> same base key
    const two = [pending({ amount: -1900 }), pending({ amount: -1900 })];
    const { adds } = planActualUpsert(two, []);
    expect(adds.map((a) => a.imported_id)).toEqual([BASE, `${BASE}#1`]);

    // now both settle -> each updates a distinct pending row, no duplicates
    const existing: ExistingActualTx[] = [
      {
        id: "a",
        imported_id: BASE,
        amount: -1900,
        cleared: false,
        notes: PENDING_NOTE,
      },
      {
        id: "b",
        imported_id: `${BASE}#1`,
        amount: -1900,
        cleared: false,
        notes: PENDING_NOTE,
      },
    ];
    const settledBatch = [
      settled({ amount: -1900, settledImportedId: "s1" }),
      settled({ amount: -1900, settledImportedId: "s2" }),
    ];
    const plan = planActualUpsert(settledBatch, existing);
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates.map((u) => u.id).sort()).toEqual(["a", "b"]);
    expect(plan.updates.map((u) => u.fields.imported_id).sort()).toEqual([
      "s1",
      "s2",
    ]);
  });
});

describe("planActualUpsert updateDateOnSettle (card charge date, #14)", () => {
  it("moves the settled row's date to the charge date when enabled", () => {
    const existing = [existingPending({ amount: -2800 })];
    const { updates } = planActualUpsert(
      // pending was dated on the purchase date; settled carries the charge date
      [settled({ amount: -2800, date: "2026-07-31" })],
      existing,
      { updateDateOnSettle: true },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].fields.date).toBe("2026-07-31");
    expect(updates[0].fields.cleared).toBe(true);
    // category is still never touched
    expect("category" in updates[0].fields).toBe(false);
  });

  it("omits the date field by default (path unchanged when off)", () => {
    const existing = [existingPending({ amount: -2800 })];
    const { updates } = planActualUpsert(
      [settled({ amount: -2800, date: "2026-07-31" })],
      existing,
    );
    expect(updates).toHaveLength(1);
    expect("date" in updates[0].fields).toBe(false);
  });
});

describe("computeCardKey", () => {
  it("matches a bank pending authorization to the card issuer's settled row", () => {
    // Same domestic amount + purchase date, different descriptions/accounts.
    const auth = computeCardKey({ date: "2026-07-19", amountMinor: -16990 });
    const settledRow = computeCardKey({
      date: "2026-07-19",
      amountMinor: -16990,
    });
    expect(auth).toBe(settledRow);
    expect(auth.startsWith("pend:")).toBe(true); // reuses the base-key/slot machinery
  });

  it("is sign-insensitive but distinguishes amount and date", () => {
    const k = computeCardKey({ date: "2026-07-19", amountMinor: -16990 });
    expect(computeCardKey({ date: "2026-07-19", amountMinor: 16990 })).toBe(k);
    expect(
      computeCardKey({ date: "2026-07-19", amountMinor: -16991 }),
    ).not.toBe(k);
    expect(
      computeCardKey({ date: "2026-07-20", amountMinor: -16990 }),
    ).not.toBe(k);
  });
});

describe("card pending -> settled reconciliation (domestic, cross-source)", () => {
  const CARD = computeCardKey({ date: "2026-07-19", amountMinor: -16990 });
  const auth = (over: Partial<IncomingTx> = {}): IncomingTx => ({
    baseKey: CARD,
    settledImportedId: "auth-hash", // never used for a pending row
    isPending: true,
    amount: -16990,
    date: "2026-07-19",
    payeeName: "דירקט אושר-ישראכרט",
    notes: "",
    ...over,
  });
  const granular = (over: Partial<IncomingTx> = {}): IncomingTx => ({
    ...auth(),
    isPending: false,
    settledImportedId: "isracard-hash",
    payeeName: "UPAPP",
    ...over,
  });

  it("day 1 — authorization alone imports as a persistent pending placeholder", () => {
    const { adds, updates } = planActualUpsert([auth()], []);
    expect(updates).toHaveLength(0);
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({
      imported_id: CARD,
      amount: -16990,
      cleared: false,
      notes: "", // owner-only field
      payee_name: "דירקט אושר-ישראכרט",
    });
  });

  it("re-scraping the still-pending authorization changes nothing", () => {
    const existing: ExistingActualTx[] = [
      {
        id: "p",
        imported_id: CARD,
        amount: -16990,
        cleared: false,
        notes: PENDING_NOTE,
      },
    ];
    const plan = planActualUpsert([auth()], existing);
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
  });

  it("later day — settled granular supersedes the placeholder in place, category intact", () => {
    const existing: ExistingActualTx[] = [
      {
        id: "p",
        imported_id: CARD,
        amount: -16990,
        cleared: false,
        notes: PENDING_NOTE,
      },
    ];
    const plan = planActualUpsert([granular()], existing);
    expect(plan.adds).toHaveLength(0); // no duplicate
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({
      id: "p",
      fields: { cleared: true, imported_id: "isracard-hash", amount: -16990 },
    });
    // category is never in the update fields
    expect("category" in plan.updates[0].fields).toBe(false);
  });

  it("SAME batch — authorization + settled both present: settled wins, no duplicate", () => {
    // The critical case: once the charge settles, the bank pending authorization
    // is still in the same scrape. Without same-batch dedup the pending would
    // re-add a placeholder alongside the settled row.
    const existing: ExistingActualTx[] = [
      {
        id: "p",
        imported_id: CARD,
        amount: -16990,
        cleared: false,
        notes: PENDING_NOTE,
      },
    ];
    const plan = planActualUpsert([auth(), granular()], existing);
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].fields.imported_id).toBe("isracard-hash");
  });

  it("same-batch authorization + settled with NO prior placeholder: one settled row only", () => {
    const plan = planActualUpsert([auth(), granular()], []);
    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0]).toMatchObject({
      imported_id: "isracard-hash",
      cleared: true,
      payee_name: "UPAPP",
    });
  });

  it("idempotent once settled: re-scraping the granular is a no-op", () => {
    const existing: ExistingActualTx[] = [
      {
        id: "p",
        imported_id: "isracard-hash",
        amount: -16990,
        cleared: true,
        notes: "",
      },
    ];
    const plan = planActualUpsert([granular()], existing);
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
  });
});

describe("placeholder payee refresh (טרם נקלט)", () => {
  const settledRow = (over = {}) => ({
    id: "r",
    imported_id: SETTLED_ID,
    amount: -1050,
    cleared: true,
    notes: "",
    date: "2026-08-11",
    imported_payee: "טרם נקלט",
    ...over,
  });

  it("isPlaceholderPayee matches only the טרם נקלט placeholder", () => {
    expect(isPlaceholderPayee("טרם נקלט")).toBe(true);
    expect(isPlaceholderPayee("  טרם נקלט  ")).toBe(true);
    expect(isPlaceholderPayee("מקס פראם")).toBe(false);
    expect(isPlaceholderPayee("")).toBe(false);
    expect(isPlaceholderPayee(null)).toBe(false);
  });

  it("refreshes a settled row's stale placeholder to the resolved merchant", () => {
    const { adds, updates } = planActualUpsert(
      [settled({ amount: -1050, payeeName: "מקס פראם מקס איט ניכ" })],
      [settledRow()],
    );
    expect(adds).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].fields).toEqual({ payeeName: "מקס פראם מקס איט ניכ" });
  });

  it("does NOT touch a real (already-resolved) payee — stays a no-op", () => {
    const { updates } = planActualUpsert(
      [settled({ amount: -1050, payeeName: "מקס פראם מקס איט ניכ" })],
      [settledRow({ imported_payee: "מקס פראם" })],
    );
    expect(updates).toHaveLength(0);
  });

  it("does not refresh when the incoming name is itself the placeholder", () => {
    const { updates } = planActualUpsert(
      [settled({ amount: -1050, payeeName: "טרם נקלט" })],
      [settledRow()],
    );
    expect(updates).toHaveLength(0);
  });
});
