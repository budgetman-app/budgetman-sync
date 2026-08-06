import { dropStalePendingCharges } from "./stalePending.js";
import {
  TransactionStatuses,
  TransactionTypes,
  type Transaction,
} from "israeli-bank-scrapers/lib/transactions.js";

const TODAY = "2026-08-06";

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    type: TransactionTypes.Normal,
    identifier: undefined,
    date: "2026-08-05T00:00:00.000Z",
    processedDate: "2026-08-05T00:00:00.000Z",
    originalAmount: -29.4,
    originalCurrency: "ILS",
    chargedAmount: -29.4,
    chargedCurrency: "ILS",
    description: "LIME*2 RIDES RUUL",
    status: TransactionStatuses.Pending,
    memo: "",
    ...over,
  };
}

describe("dropStalePendingCharges", () => {
  it("drops a pending older than the threshold (the ₪6 Lime orphan, 20 days)", () => {
    const rows = [tx({ date: "2026-07-17T00:00:00.000Z", chargedAmount: -6 })];
    const { kept, dropped } = dropStalePendingCharges(rows, 14, TODAY);
    expect(dropped).toHaveLength(1);
    expect(kept).toHaveLength(0);
  });

  it("keeps a pending still within the threshold (the ₪29.40, 5 days)", () => {
    const rows = [
      tx({ date: "2026-08-01T00:00:00.000Z", chargedAmount: -29.4 }),
    ];
    const { kept, dropped } = dropStalePendingCharges(rows, 14, TODAY);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("NEVER drops a completed/settled row, however old", () => {
    const rows = [
      tx({
        date: "2026-01-01T00:00:00.000Z",
        status: TransactionStatuses.Completed,
      }),
    ];
    const { kept, dropped } = dropStalePendingCharges(rows, 14, TODAY);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("is disabled when the threshold is 0 (drops nothing)", () => {
    const rows = [tx({ date: "2026-01-01T00:00:00.000Z" })]; // ancient pending
    const { kept, dropped } = dropStalePendingCharges(rows, 0, TODAY);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("uses the Jerusalem date and treats exactly-threshold as still fresh", () => {
    // 2026-07-23 is exactly 14 days before 2026-08-06 -> gap 14, not > 14 -> kept.
    const rows = [tx({ date: "2026-07-23T00:00:00.000Z" })];
    expect(dropStalePendingCharges(rows, 14, TODAY).dropped).toHaveLength(0);
    // one day older -> dropped
    const older = [tx({ date: "2026-07-22T00:00:00.000Z" })];
    expect(dropStalePendingCharges(older, 14, TODAY).dropped).toHaveLength(1);
  });

  it("partitions a mixed batch, preserving order of kept rows", () => {
    const rows = [
      tx({ date: "2026-07-17T00:00:00.000Z", description: "old pending" }),
      tx({ date: "2026-08-04T00:00:00.000Z", description: "fresh pending" }),
      tx({
        date: "2026-01-01T00:00:00.000Z",
        status: TransactionStatuses.Completed,
        description: "old settled",
      }),
    ];
    const { kept, dropped } = dropStalePendingCharges(rows, 14, TODAY);
    expect(dropped.map((d) => d.description)).toEqual(["old pending"]);
    expect(kept.map((k) => k.description)).toEqual([
      "fresh pending",
      "old settled",
    ]);
  });
});
