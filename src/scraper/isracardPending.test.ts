import {
  collectApprovalsByCard,
  convertApprovalToTransaction,
  extractApprovals,
  nextBillingMonth,
  withCard,
  withNextBilling,
  type ApprovalsFetcher,
} from "./isracardPending.js";
import {
  TransactionStatuses,
  TransactionTypes,
} from "israeli-bank-scrapers/lib/transactions.js";

describe("withNextBilling", () => {
  it("flips isNextBillingDate to true, preserving the other fields", () => {
    const body = {
      card4Number: "0041",
      isNextBillingDate: false,
      cardStatus: 0,
      billingMonth: "01/08/2026",
      companyCode: 11,
      isPartner: false,
    };
    expect(withNextBilling(body)).toEqual({ ...body, isNextBillingDate: true });
    // does not mutate the input
    expect(body.isNextBillingDate).toBe(false);
  });
});

describe("extractApprovals", () => {
  it("returns the approvedTransactions array when present", () => {
    const json = {
      data: { approvals: { approvedTransactions: [{ cardSuffix: "0041" }] } },
    };
    expect(extractApprovals(json)).toEqual([{ cardSuffix: "0041" }]);
  });

  it("returns [] when approvals is null (the isNextBillingDate:false response)", () => {
    expect(extractApprovals({ data: { approvals: null } })).toEqual([]);
  });

  it("returns [] for missing/garbage shapes without throwing", () => {
    expect(extractApprovals(undefined)).toEqual([]);
    expect(extractApprovals({})).toEqual([]);
    expect(extractApprovals({ data: {} })).toEqual([]);
    expect(extractApprovals("nope")).toEqual([]);
  });
});

describe("withCard", () => {
  it("sets card4Number and forces isNextBillingDate, keeping billing month", () => {
    const body = {
      card4Number: "5104",
      isNextBillingDate: false,
      billingMonth: "01/08/2026",
      companyCode: 11,
    };
    expect(withCard(body, "0041")).toEqual({
      card4Number: "0041",
      isNextBillingDate: true,
      billingMonth: "01/08/2026",
      companyCode: 11,
    });
  });
});

describe("nextBillingMonth", () => {
  it("increments the month, rolling the year over", () => {
    expect(nextBillingMonth("01/08/2026")).toBe("01/09/2026");
    expect(nextBillingMonth("01/12/2026")).toBe("01/01/2027");
  });
  it("returns the input unchanged when unparseable", () => {
    expect(nextBillingMonth("garbage")).toBe("garbage");
    expect(nextBillingMonth(undefined)).toBeUndefined();
  });
});

describe("collectApprovalsByCard (multi-card enumeration)", () => {
  const template = {
    url: "https://web.isracard.co.il/ocp/transactions/DigitalV3.Transactions/GetTransactionsList",
    body: {
      card4Number: "5104", // the SPA's primary card
      isNextBillingDate: false,
      billingMonth: "01/08/2026",
      companyCode: 11,
    },
  };
  const approval = (over: Record<string, unknown> = {}) => ({
    purchaseDate: "02/08/2026",
    businessName: "משרתי הקבע רב מוטב",
    originalAmount: 692,
    currencyIso: "ILS",
    ilsBillingAmount: 692,
    creditOrCharge: 1,
    cardSuffix: "0041",
    ...over,
  });
  const wrap = (rows: unknown[]) => ({
    data: { approvals: { approvedTransactions: rows } },
  });

  it("issues one isNextBillingDate:true fetch per card and unions the approvals", async () => {
    const calls: Array<{ card?: string; nextBilling?: boolean }> = [];
    const fetch: ApprovalsFetcher = async (_url, body) => {
      calls.push({
        card: body.card4Number,
        nextBilling: body.isNextBillingDate,
      });
      // Only 0041 has pending; 5104 and 9999 have none.
      return body.card4Number === "0041" ? wrap([approval()]) : wrap([]);
    };

    const result = await collectApprovalsByCard({
      template,
      cards: ["5104", "0041", "9999"],
      fetch,
    });

    // one fetch per card for the current month (none had 0-then-nonzero to retry
    // except empties, which also probe next month) — every call flips the flag
    expect(calls.every((c) => c.nextBilling === true)).toBe(true);
    expect(calls.map((c) => c.card)).toEqual(
      expect.arrayContaining(["5104", "0041", "9999"]),
    );
    // only 0041 contributed; null/empty cards contribute nothing
    expect([...result.keys()]).toEqual(["0041"]);
    expect(result.get("0041")).toHaveLength(1);
    expect(result.get("0041")![0].chargedAmount).toBe(-692);
  });

  it("probes the NEXT billing month when a card's current month is empty", async () => {
    const seen: string[] = [];
    const fetch: ApprovalsFetcher = async (_url, body) => {
      seen.push(`${body.card4Number}@${body.billingMonth}`);
      // 0041 empty for 01/08 but has a row for 01/09 (next statement)
      if (body.card4Number === "0041" && body.billingMonth === "01/09/2026") {
        return wrap([approval({ purchaseDate: "20/08/2026" })]);
      }
      return wrap([]);
    };

    const result = await collectApprovalsByCard({
      template,
      cards: ["0041"],
      fetch,
    });
    expect(seen).toEqual(["0041@01/08/2026", "0041@01/09/2026"]);
    expect(result.get("0041")).toHaveLength(1);
  });

  it("de-dupes identical approvals returned for more than one card query", async () => {
    // Same underlying row surfaces for two cards; it must count once.
    const fetch: ApprovalsFetcher = async () => wrap([approval()]);
    const result = await collectApprovalsByCard({
      template,
      cards: ["0041", "5104"],
      fetch,
    });
    expect(result.get("0041")).toHaveLength(1);
  });

  it("falls back to the template's own card when no card list is given", async () => {
    const cardsSeen: Array<string | undefined> = [];
    const fetch: ApprovalsFetcher = async (_url, body) => {
      cardsSeen.push(body.card4Number);
      return wrap([]);
    };
    await collectApprovalsByCard({ template, cards: undefined, fetch });
    // current month + next month for the single template card
    expect(cardsSeen).toEqual(["5104", "5104"]);
  });
});

describe("convertApprovalToTransaction", () => {
  it("maps a pending FX charge using currencyIso and negates the charge", () => {
    // Real shape captured from the Isracard approvals endpoint.
    const tx = convertApprovalToTransaction({
      purchaseDate: "03/07/2026",
      businessName: "UPSTASH",
      originalAmount: 20,
      originalCurrency: 19 as unknown as undefined, // numeric code — must be ignored
      currencyIso: "USD",
      ilsBillingAmount: 60.04,
      creditOrCharge: 1,
      cardSuffix: "0041",
    } as never);

    expect(tx.status).toBe(TransactionStatuses.Pending);
    expect(tx.type).toBe(TransactionTypes.Normal);
    expect(tx.originalAmount).toBe(-20);
    expect(tx.originalCurrency).toBe("USD");
    expect(tx.chargedAmount).toBe(-60.04);
    expect(tx.chargedCurrency).toBe("ILS");
    expect(tx.description).toBe("UPSTASH");
    expect(tx.date).toBe("2026-07-03T00:00:00.000Z");
    expect(tx.processedDate).toBe("2026-07-03T00:00:00.000Z");
    expect(tx.identifier).toBeUndefined();
  });

  it("maps a domestic ILS pending charge", () => {
    const tx = convertApprovalToTransaction({
      purchaseDate: "02/07/2026",
      businessName: "טורטיה בר חולון",
      originalAmount: 130,
      currencyIso: "ILS",
      ilsBillingAmount: 130,
      creditOrCharge: 1,
      cardSuffix: "0041",
    });

    expect(tx.originalAmount).toBe(-130);
    expect(tx.originalCurrency).toBe("ILS");
    expect(tx.chargedAmount).toBe(-130);
  });

  it("treats a non-charge (credit/refund) as positive", () => {
    const tx = convertApprovalToTransaction({
      purchaseDate: "01/07/2026",
      businessName: "REFUND",
      originalAmount: 50,
      currencyIso: "ILS",
      ilsBillingAmount: 50,
      creditOrCharge: 2,
      cardSuffix: "0041",
    });

    expect(tx.chargedAmount).toBe(50);
    expect(tx.originalAmount).toBe(50);
  });

  it("falls back to now for an unparseable date without throwing", () => {
    const tx = convertApprovalToTransaction({
      purchaseDate: "",
      businessName: "X",
      originalAmount: 1,
      currencyIso: "ILS",
      ilsBillingAmount: 1,
      creditOrCharge: 1,
    });
    expect(() => new Date(tx.date).toISOString()).not.toThrow();
  });
});
