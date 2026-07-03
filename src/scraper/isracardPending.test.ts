import { convertApprovalToTransaction } from "./isracardPending.js";
import {
  TransactionStatuses,
  TransactionTypes,
} from "israeli-bank-scrapers/lib/transactions.js";

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
