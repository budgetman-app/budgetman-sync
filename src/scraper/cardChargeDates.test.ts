import {
  matchChargeDatesToGranular,
  normalizeMerchant,
  settlementRefFromDebit,
  isIsracardSettlementDebit,
} from "./cardChargeDates.js";
import type { FibiCardExpense } from "./fibiCardExpenses.js";
import {
  TransactionStatuses,
  TransactionTypes,
  type Transaction,
} from "israeli-bank-scrapers/lib/transactions.js";

function granular(over: Partial<Transaction>): Transaction {
  return {
    type: TransactionTypes.Normal,
    identifier: undefined,
    date: "2026-07-29T00:00:00.000Z",
    processedDate: "2026-08-19T00:00:00.000Z", // WRONG monthly date from the scraper
    originalAmount: -28,
    originalCurrency: "ILS",
    chargedAmount: -28,
    chargedCurrency: "ILS",
    description: "חנות הדוגמה",
    status: TransactionStatuses.Completed,
    memo: "",
    ...over,
  };
}

function expense(over: Partial<FibiCardExpense>): FibiCardExpense {
  return {
    purchaseDate: "29/07/2026",
    chargeDate: "31/07/2026",
    merchant: "חנות הדוגמה",
    dealAmount: 28,
    chargeAmount: 28,
    ...over,
  };
}

describe("normalizeMerchant", () => {
  it("collapses whitespace, trims, and lower-cases", () => {
    expect(normalizeMerchant("  ANTHROPIC*CLAUDE  ")).toBe("anthropic*claude");
    expect(normalizeMerchant('חנות הדוגמה בע"מ ')).toBe('חנות הדוגמה בע"מ');
  });
});

describe("matchChargeDatesToGranular", () => {
  it("sets processedDate to the FIBI charge date on a matched granular row", () => {
    const g = [granular({})];
    const res = matchChargeDatesToGranular(g, [expense({})]);
    expect(res.updated).toBe(1);
    expect(res.unmatched).toHaveLength(0);
    // 31/07/2026 charge date -> UTC-midnight ISO (TZ-safe downstream)
    expect(g[0].processedDate).toBe("2026-07-31T00:00:00.000Z");
  });

  it("matches despite a trailing-space / casing merchant difference", () => {
    const g = [granular({ description: "Rami Levy" })];
    const res = matchChargeDatesToGranular(g, [
      expense({ merchant: "RAMI LEVY  " }),
    ]);
    expect(res.updated).toBe(1);
    expect(g[0].processedDate).toBe("2026-07-31T00:00:00.000Z");
  });

  it("maps an N-purchase settlement onto N distinct granular rows (no reuse)", () => {
    // Two identical-looking purchases (same merchant/amount/date) settle together.
    const g = [
      granular({ identifier: "a" }),
      granular({ identifier: "b" }),
      granular({ description: "אחר", chargedAmount: -99 }), // unrelated
    ];
    const res = matchChargeDatesToGranular(g, [expense({}), expense({})]);
    expect(res.updated).toBe(2);
    expect(g[0].processedDate).toBe("2026-07-31T00:00:00.000Z");
    expect(g[1].processedDate).toBe("2026-07-31T00:00:00.000Z");
    expect(g[2].processedDate).toBe("2026-08-19T00:00:00.000Z"); // untouched
  });

  it("does not match when amount or purchase date differs", () => {
    const g = [
      granular({ chargedAmount: -30 }), // amount mismatch
      granular({ date: "2026-07-28T00:00:00.000Z" }), // date mismatch
    ];
    const res = matchChargeDatesToGranular(g, [expense({})]);
    expect(res.updated).toBe(0);
    expect(res.unmatched).toHaveLength(1);
    expect(g[0].processedDate).toBe("2026-08-19T00:00:00.000Z");
    expect(g[1].processedDate).toBe("2026-08-19T00:00:00.000Z");
  });

  it("leaves an extra drill-down row unmatched rather than reusing a granular", () => {
    const g = [granular({})];
    const res = matchChargeDatesToGranular(g, [expense({}), expense({})]);
    expect(res.updated).toBe(1);
    expect(res.unmatched).toHaveLength(1);
  });
});

describe("isIsracardSettlementDebit / settlementRefFromDebit", () => {
  const debit = (over: Partial<Transaction> = {}): Transaction =>
    granular({
      description: '0041 - ישראכרט בע"מ',
      identifier: "13795",
      date: "2026-07-31T00:00:00.000Z",
      chargedAmount: -1278.06,
      ...over,
    });

  it("recognizes a booked Isracard settlement debit", () => {
    expect(isIsracardSettlementDebit(debit())).toBe(true);
    expect(isIsracardSettlementDebit(debit({ identifier: undefined }))).toBe(
      false,
    );
    expect(
      isIsracardSettlementDebit(debit({ status: TransactionStatuses.Pending })),
    ).toBe(false);
  });

  it("builds I-SEL-MS-KARTIS = 0 + card4 + ref7 and dd.mm.yyyy charge date", () => {
    // From the one live example: card 0041 + ref 13795 -> 000410013795.
    const ref = settlementRefFromDebit(debit());
    expect(ref).toEqual({
      cardStatementRef: "000410013795",
      chargeDate: "31.07.2026",
    });
  });

  it("returns null when the card/reference cannot be derived", () => {
    expect(settlementRefFromDebit(debit({ description: "משכורת" }))).toBeNull();
    expect(settlementRefFromDebit(debit({ identifier: undefined }))).toBeNull();
  });
});
