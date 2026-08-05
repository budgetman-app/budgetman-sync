import {
  dedupeApprovalsAgainstCompleted,
  matchChargeDatesToGranular,
  merchantsMatch,
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
  it("collapses whitespace + punctuation, trims, and lower-cases", () => {
    expect(normalizeMerchant("  ANTHROPIC*CLAUDE  ")).toBe("anthropic claude");
  });

  it("folds punctuation so the two Isracard renderings of LIME agree", () => {
    // Drill-down uses '*', some granular use a space — same merchant.
    expect(normalizeMerchant("LIME*2 RIDES RUUL")).toBe("lime 2 rides ruul");
    expect(normalizeMerchant("LIME 2 RIDES RUUL")).toBe("lime 2 rides ruul");
    expect(normalizeMerchant("LIME*2 RIDES RUUL")).toBe(
      normalizeMerchant("LIME 2 RIDES RUUL"),
    );
  });

  it("keeps Hebrew letters and digits, only flattening punctuation", () => {
    expect(normalizeMerchant("סופר פארם")).toBe("סופר פארם"); // unchanged
    expect(normalizeMerchant("רמי לוי-סניף 5")).toBe("רמי לוי סניף 5"); // '-' -> space
    expect(normalizeMerchant('חנות הדוגמה בע"מ ')).toBe("חנות הדוגמה בע מ");
  });
});

describe("merchantsMatch", () => {
  // Inputs are already punctuation-normalized (see normalizeMerchant).
  it("(a) matches differently-truncated renderings via a common prefix", () => {
    expect(
      merchantsMatch("google workspace rec", "google workspace recov"),
    ).toBe(true);
  });

  it("(b) still matches the LIME *↔space case (equal after normalization)", () => {
    expect(merchantsMatch("lime 2 rides ruul", "lime 2 rides ruul")).toBe(true);
  });

  it("(c) does NOT match short merchants below the 6-char prefix floor", () => {
    expect(merchantsMatch("up", "upapp")).toBe(false);
  });

  it("does not match unrelated names that share no prefix", () => {
    expect(merchantsMatch("google workspace", "microsoft azure")).toBe(false);
  });

  it("requires a real prefix, not just any 6-char overlap", () => {
    expect(merchantsMatch("netflix", "netfli")).toBe(true); // prefix, len 6
    expect(merchantsMatch("amazon prime", "amazon web svc")).toBe(false); // diverge after "amazon "
  });
});

describe("dedupeApprovalsAgainstCompleted", () => {
  // ארומה −17 on 04/08: the real double — same charge in both buckets.
  const approval = (over: Partial<Transaction> = {}): Transaction => ({
    type: TransactionTypes.Normal,
    identifier: undefined,
    date: "2026-08-04T00:00:00.000Z",
    processedDate: "2026-08-04T00:00:00.000Z",
    originalAmount: -17,
    originalCurrency: "ILS",
    chargedAmount: -17,
    chargedCurrency: "ILS",
    description: "ארומה",
    status: TransactionStatuses.Pending,
    memo: "",
    ...over,
  });
  const completed = (over: Partial<Transaction> = {}): Transaction =>
    approval({
      status: TransactionStatuses.Completed,
      identifier: "V",
      ...over,
    });

  it("(a) drops an approval that Isracard already captured as a completed txn", () => {
    const kept = dedupeApprovalsAgainstCompleted([approval()], [completed()]);
    expect(kept).toHaveLength(0);
  });

  it("(b) keeps an approval with no completed twin", () => {
    const kept = dedupeApprovalsAgainstCompleted(
      [approval()],
      [
        completed({
          description: "משהו אחר",
          chargedAmount: -50,
          originalAmount: -50,
        }),
      ],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].description).toBe("ארומה");
  });

  it("(c) leaves distinct same-signature charges in one bucket untouched (3 pending, 0 completed)", () => {
    const three = [approval(), approval(), approval()];
    const kept = dedupeApprovalsAgainstCompleted(three, []);
    expect(kept).toHaveLength(3);
  });

  it("(d) consume-once: 2 same-signature approvals + 1 completed twin -> keeps one", () => {
    const kept = dedupeApprovalsAgainstCompleted(
      [approval(), approval()],
      [completed()],
    );
    expect(kept).toHaveLength(1); // one stale dup dropped, the genuine pending kept
  });

  it("does not match across a different merchant, amount, or purchase date", () => {
    expect(
      dedupeApprovalsAgainstCompleted(
        [approval()],
        [completed({ description: "ארומה תל אביב" })], // different merchant
      ),
    ).toHaveLength(1);
    expect(
      dedupeApprovalsAgainstCompleted(
        [approval()],
        [completed({ originalAmount: -18, chargedAmount: -18 })], // different amount
      ),
    ).toHaveLength(1);
    expect(
      dedupeApprovalsAgainstCompleted(
        [approval()],
        [completed({ date: "2026-08-03T00:00:00.000Z" })], // different date
      ),
    ).toHaveLength(1);
  });

  it("ignores non-completed rows in the completed pool and preserves order", () => {
    const a1 = approval({ description: "ראשון" });
    const a2 = approval(); // ארומה, has a completed twin
    const kept = dedupeApprovalsAgainstCompleted(
      [a1, a2],
      [approval() /* pending, not a twin */, completed()],
    );
    expect(kept.map((k) => k.description)).toEqual(["ראשון"]);
  });
});

describe("matchChargeDatesToGranular", () => {
  it("sets processedDate + marks bankSettled on a matched granular row", () => {
    const g = [granular({})];
    const res = matchChargeDatesToGranular(g, [expense({})]);
    expect(res.updated).toBe(1);
    expect(res.unmatched).toHaveLength(0);
    // 31/07/2026 charge date -> UTC-midnight ISO (TZ-safe downstream)
    expect(g[0].processedDate).toBe("2026-07-31T00:00:00.000Z");
    // POSTED-by-FIBI marker for clearOnFibiSettlement
    expect((g[0] as { bankSettled?: boolean }).bankSettled).toBe(true);
  });

  it("leaves unmatched granular UNMARKED (not bank-settled)", () => {
    const g = [granular({ chargedAmount: -30 })]; // amount mismatch -> no match
    const res = matchChargeDatesToGranular(g, [expense({})]);
    expect(res.updated).toBe(0);
    expect((g[0] as { bankSettled?: boolean }).bankSettled).toBeUndefined();
  });

  it("matches despite a trailing-space / casing merchant difference", () => {
    const g = [granular({ description: "Rami Levy" })];
    const res = matchChargeDatesToGranular(g, [
      expense({ merchant: "RAMI LEVY  " }),
    ]);
    expect(res.updated).toBe(1);
    expect(g[0].processedDate).toBe("2026-07-31T00:00:00.000Z");
  });

  it("pairs a 'LIME*2' drill-down line to a 'LIME 2' granular (punctuation folded)", () => {
    // The real unmatched-LIME bug: '*' vs ' ' between the same words.
    const g = [
      granular({ description: "LIME 2 RIDES RUUL", chargedAmount: -26.3 }),
    ];
    const res = matchChargeDatesToGranular(g, [
      expense({ merchant: "LIME*2 RIDES RUUL", chargeAmount: 26.3 }),
    ]);
    expect(res.updated).toBe(1);
    expect(res.unmatched).toHaveLength(0);
    expect(g[0].processedDate).toBe("2026-07-31T00:00:00.000Z");
    expect((g[0] as { bankSettled?: boolean }).bankSettled).toBe(true);
  });

  it("pairs a TRUNCATED granular to a longer drill-down line of the same amount+date", () => {
    // Real case: granular "GOOGLE WORKSPACE REC" vs drill-down "GOOGLE*WORKSPACE RECOV".
    const g = [
      granular({ description: "GOOGLE WORKSPACE REC", chargedAmount: -35 }),
    ];
    const res = matchChargeDatesToGranular(g, [
      expense({ merchant: "GOOGLE*WORKSPACE RECOV", chargeAmount: 35 }),
    ]);
    expect(res.updated).toBe(1);
    expect(res.unmatched).toHaveLength(0);
    expect(g[0].processedDate).toBe("2026-07-31T00:00:00.000Z");
    expect((g[0] as { bankSettled?: boolean }).bankSettled).toBe(true);
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
