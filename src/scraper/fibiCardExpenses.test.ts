import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFibiCardExpensesUrl,
  convertFibiExpenseToTransaction,
  parseFibiCardExpenses,
} from "./fibiCardExpenses.js";
import {
  TransactionStatuses,
  TransactionTypes,
} from "israeli-bank-scrapers/lib/transactions.js";

const FIXTURE = readFileSync(
  join(__dirname, "__fixtures__", "fibiCardExpenses.html"),
  "utf-8",
);

describe("buildFibiCardExpensesUrl", () => {
  it("builds the SUGBAKA=211 drill-down URL for a settlement debit", () => {
    const url = new URL(
      buildFibiCardExpensesUrl({
        cardStatementRef: "000410013795",
        chargeDate: "31.07.2026",
      }),
    );
    expect(url.pathname).toBe(
      "/MatafServiceServlets/MatafPortalServiceServlet",
    );
    expect(url.searchParams.get("SUGBAKA")).toBe("211");
    expect(url.searchParams.get("I-SEL-MS-KARTIS")).toBe("000410013795");
    expect(url.searchParams.get("I-TR-CHIYUV")).toBe("31.07.2026");
    expect(url.searchParams.get("I-D-STATUS")).toBe("CH-KAROV");
  });
});

describe("parseFibiCardExpenses", () => {
  it("extracts the itemised expenses, anchored on the header, skipping chrome", () => {
    const rows = parseFibiCardExpenses(FIXTURE);
    expect(rows).toHaveLength(3);
    // Column order: purchase date | charge date | merchant | deal | charge.
    // Trailing &nbsp; on the merchant is trimmed.
    expect(rows[0]).toEqual({
      purchaseDate: "29/07/2026",
      chargeDate: "31/07/2026",
      merchant: 'חנות הדוגמה בע"מ',
      dealAmount: 28,
      chargeAmount: 28,
    });
  });

  it("parses thousands separators and preserves DD/MM/YYYY", () => {
    const rows = parseFibiCardExpenses(FIXTURE);
    expect(rows[2].merchant).toBe("סופרמרקט לדוגמה");
    expect(rows[2].chargeAmount).toBe(1234.56);
    expect(rows[1].chargeDate).toBe("19/07/2026");
  });

  it("returns [] for empty/garbage HTML without throwing", () => {
    expect(parseFibiCardExpenses("")).toEqual([]);
    expect(parseFibiCardExpenses("<html><body>nope</body></html>")).toEqual([]);
  });

  it("still parses when the header is absent (shape-based fallback)", () => {
    const noHeader = `<table><tr>
      <td>29/07/2026</td><td>31/07/2026</td><td>מסעדה</td><td>10.00</td><td>10.00</td><td></td>
    </tr></table>`;
    const rows = parseFibiCardExpenses(noHeader);
    expect(rows).toHaveLength(1);
    expect(rows[0].merchant).toBe("מסעדה");
  });
});

describe("convertFibiExpenseToTransaction", () => {
  it("dates on purchase, processedDate on the real charge date, negative", () => {
    const tx = convertFibiExpenseToTransaction({
      purchaseDate: "29/07/2026",
      chargeDate: "31/07/2026",
      merchant: "מסעדת הבדיקה",
      dealAmount: 28,
      chargeAmount: 28,
    });
    expect(tx.status).toBe(TransactionStatuses.Completed);
    expect(tx.type).toBe(TransactionTypes.Normal);
    expect(tx.description).toBe("מסעדת הבדיקה");
    expect(tx.chargedAmount).toBe(-28);
    expect(tx.originalCurrency).toBe("ILS");
    // purchase date -> date; charge date -> processedDate (the clearing clock)
    expect(tx.date).toBe("2026-07-29T00:00:00.000Z");
    expect(tx.processedDate).toBe("2026-07-31T00:00:00.000Z");
    expect(tx.identifier).toBeUndefined();
  });
});
