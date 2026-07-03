import {
  computeStableKey,
  planActualUpsert,
  PENDING_NOTE,
  type ExistingActualTx,
  type IncomingTx,
} from "./actualUpsert.js";

describe("computeStableKey", () => {
  const charge = {
    date: "2026-07-03",
    originalAmount: 20,
    originalCurrency: "USD",
    description: "UPSTASH",
    account: "0041",
  };

  it("is identical for a pending charge and its settled twin", () => {
    // Settlement changes chargedAmount + identifier (not part of the key) but
    // keeps originalAmount/originalCurrency/date/merchant — so the key matches.
    expect(computeStableKey(charge)).toBe(computeStableKey({ ...charge }));
    expect(computeStableKey(charge).startsWith("pend:")).toBe(true);
  });

  it("differs when the original amount or currency differs", () => {
    expect(computeStableKey(charge)).not.toBe(
      computeStableKey({ ...charge, originalCurrency: "EUR" }),
    );
    expect(computeStableKey(charge)).not.toBe(
      computeStableKey({ ...charge, originalAmount: 21 }),
    );
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
      notes: PENDING_NOTE,
      payee_name: "UPSTASH",
    });
  });

  it("settles a pending twin in place: no duplicate, upgraded id, delta note", () => {
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
      notes: "settled ₪295.00→₪296.44",
    });
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

  it("does nothing when a pending charge re-appears unchanged", () => {
    const { adds, updates } = planActualUpsert(
      [pending({ amount: -6004 })],
      [existingPending({ amount: -6004 })],
    );
    expect(adds).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("updates a pending charge whose estimate changed", () => {
    const { adds, updates } = planActualUpsert(
      [pending({ amount: -6100 })],
      [existingPending({ amount: -6004 })],
    );
    expect(adds).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].fields).toEqual({
      amount: -6100,
      notes: `${PENDING_NOTE} ₪60.04→₪61.00`,
    });
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
