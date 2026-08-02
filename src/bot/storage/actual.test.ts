import { jest } from "@jest/globals";
import {
  TransactionStatuses,
  TransactionTypes,
  type Transaction,
} from "israeli-bank-scrapers/lib/transactions.js";
import type { MoneymanConfig } from "../../config.js";
import type { TransactionRow } from "../../types.js";

jest.mock("../../utils/logger.js", () => ({ createLogger: () => jest.fn() }));

// In-memory Actual: importTransactions adds (dedup by imported_id),
// updateTransaction mutates only the given fields (so category survives unless
// explicitly changed), getTransactions returns the account's rows.
jest.mock("@actual-app/api", () => {
  let store: any[] = [];
  let idCounter = 0;
  return {
    init: jest.fn(async () => {}),
    downloadBudget: jest.fn(async () => {}),
    getAccounts: jest.fn(async () => [{ id: "act-1", name: "Isracard 0041" }]),
    getTransactions: jest.fn(async (accountId: string) =>
      store.filter((r) => r.account === accountId).map((r) => ({ ...r })),
    ),
    importTransactions: jest.fn(async (accountId: string, entities: any[]) => {
      const added: string[] = [];
      for (const e of entities) {
        if (store.some((r) => r.imported_id === e.imported_id)) continue;
        const row = {
          id: `t${++idCounter}`,
          category: null,
          cleared: false,
          notes: "",
          ...e,
          account: accountId,
        };
        store.push(row);
        added.push(row.id);
      }
      return { added, updated: [], errors: [] };
    }),
    updateTransaction: jest.fn(async (id: string, fields: any) => {
      const row = store.find((r) => r.id === id);
      if (row) Object.assign(row, fields);
      return [];
    }),
    shutdown: jest.fn(async () => {}),
    utils: { amountToInteger: (n: number) => Math.round(n * 100) },
    __store: () => store,
    __reset: () => {
      store.length = 0;
      idCounter = 0;
    },
  };
});

import * as actualApi from "@actual-app/api";
import { ActualBudgetStorage } from "./actual.js";
import { matchChargeDatesToGranular } from "../../scraper/cardChargeDates.js";

const storeOf = () => (actualApi as any).__store() as any[];
const resetStore = () => (actualApi as any).__reset();

function makeConfig(actualOver: Record<string, unknown> = {}): MoneymanConfig {
  return {
    storage: {
      actual: {
        serverUrl: "http://actual:5006",
        password: "p",
        budgetId: "b",
        accounts: { "0041": "act-1" },
        keepPending: true,
        upsert: true,
        excludeDescriptions: [],
        ...actualOver,
      },
    },
    options: { scraping: { transactionHashType: "moneyman" } },
  } as unknown as MoneymanConfig;
}

const DATE = "2026-07-03T13:27:00.000Z";

function row(over: Partial<TransactionRow>): TransactionRow {
  const base: Transaction = {
    type: TransactionTypes.Normal,
    identifier: undefined,
    date: DATE,
    processedDate: DATE,
    originalAmount: -20,
    originalCurrency: "USD",
    chargedAmount: -60.04,
    chargedCurrency: "ILS",
    description: "UPSTASH",
    memo: "",
    status: TransactionStatuses.Pending,
  };
  return {
    ...base,
    account: "0041",
    companyId: "isracard" as TransactionRow["companyId"],
    hash: "h",
    uniqueId: "u-pending",
    ...over,
  } as TransactionRow;
}

async function save(
  txns: TransactionRow[],
  actualOver: Record<string, unknown> = {},
) {
  const storage = new ActualBudgetStorage(makeConfig(actualOver));
  return storage.saveTransactions(txns, async () => {});
}

describe("ActualBudgetStorage upsert (pending -> settled)", () => {
  beforeEach(() => resetStore());

  it("FX: pending then settle collapses to one updated row, category intact", async () => {
    // 1) pending FX charge imported as uncleared
    await save([row({ status: TransactionStatuses.Pending, uniqueId: "u-p" })]);
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false);
    expect(rows[0].notes).toBe("PENDING");
    expect(rows[0].amount).toBe(-6004);
    const pendingImportedId = rows[0].imported_id;
    expect(pendingImportedId.startsWith("pend:")).toBe(true);

    // 2) human categorizes the pending row
    rows[0].category = "cat-groceries";

    // 3) it settles: ILS estimate moved 60.04 -> 59.20, voucher assigned
    await save([
      row({
        status: TransactionStatuses.Completed,
        chargedAmount: -59.2,
        identifier: "VOUCH123",
        uniqueId: "u-s",
      }),
    ]);

    rows = storeOf();
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].amount).toBe(-5920); // final amount
    expect(rows[0].cleared).toBe(true); // cleared flipped
    expect(rows[0].notes).toBe("settled ₪60.04→₪59.20"); // delta note
    expect(rows[0].imported_id).not.toBe(pendingImportedId); // upgraded id
    expect(rows[0].category).toBe("cat-groceries"); // category preserved

    // 4) idempotent: re-importing the settled charge changes nothing
    await save([
      row({
        status: TransactionStatuses.Completed,
        chargedAmount: -59.2,
        identifier: "VOUCH123",
        uniqueId: "u-s",
      }),
    ]);
    expect(storeOf()).toHaveLength(1);
    expect(storeOf()[0].category).toBe("cat-groceries");
  });

  it("domestic ILS: settle flips cleared on one row, category intact, amount unchanged", async () => {
    const domestic = (over: Partial<TransactionRow>) =>
      row({
        description: "טורטיה בר חולון",
        originalAmount: -130,
        originalCurrency: "ILS",
        chargedAmount: -130,
        ...over,
      });

    await save([
      domestic({ status: TransactionStatuses.Pending, uniqueId: "d-p" }),
    ]);
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false);
    rows[0].category = "cat-food";

    await save([
      domestic({
        status: TransactionStatuses.Completed,
        identifier: "V-DOM",
        uniqueId: "d-s",
      }),
    ]);
    rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(-13000);
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].notes).toBe("settled ₪130.00→₪130.00");
    expect(rows[0].category).toBe("cat-food");
  });
});

describe("ActualBudgetStorage clearOnChargeDate (card lifecycle, #14)", () => {
  beforeEach(() => resetStore());

  // A domestic Isracard card charge. Purchase 2026-07-03; once settled the FIBI
  // drill-down / Isracard enrichment stamps processedDate with the real bank
  // charge date (2026-07-30T21:00Z = 2026-07-31 in Israel — also exercises the
  // 21:00Z off-by-one the TZ-safe formatter must get right).
  const PURCHASE = "2026-07-03T13:27:00.000Z";
  const CHARGE = "2026-07-30T21:00:00.000Z";
  const cfg = { clearOnChargeDate: true };
  const card = (over: Partial<TransactionRow>) =>
    row({
      description: "רי באר",
      originalAmount: -28,
      originalCurrency: "ILS",
      chargedAmount: -28,
      date: PURCHASE,
      processedDate: PURCHASE,
      ...over,
    });

  it("pending imports uncleared, dated on the purchase date", async () => {
    await save(
      [card({ status: TransactionStatuses.Pending, uniqueId: "p" })],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false);
    expect(rows[0].date).toBe("2026-07-03");
  });

  it("settled clears and re-dates onto the real charge date; one row, category kept", async () => {
    await save(
      [card({ status: TransactionStatuses.Pending, uniqueId: "p" })],
      cfg,
    );
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    rows[0].category = "cat-groceries";

    await save(
      [
        card({
          status: TransactionStatuses.Completed,
          processedDate: CHARGE, // real bank charge date
          identifier: "V-RIBEER",
          uniqueId: "s",
        }),
      ],
      cfg,
    );
    rows = storeOf();
    expect(rows).toHaveLength(1); // collapsed, no duplicate
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].date).toBe("2026-07-31"); // charge date, TZ-safe (Israel)
    expect(rows[0].category).toBe("cat-groceries"); // preserved
  });

  it("records the settle note in place on collapse", async () => {
    await save(
      [card({ status: TransactionStatuses.Pending, uniqueId: "p" })],
      cfg,
    );
    await save(
      [
        card({
          status: TransactionStatuses.Completed,
          processedDate: CHARGE,
          uniqueId: "s",
        }),
      ],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].notes).toBe("settled ₪28.00→₪28.00");
  });

  it("a settled charge with no pending twin adds directly on the charge date", async () => {
    await save(
      [
        card({
          status: TransactionStatuses.Completed,
          processedDate: CHARGE,
          uniqueId: "s",
        }),
      ],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].date).toBe("2026-07-31");
  });

  it("is off by default: settled card row keeps the purchase date", async () => {
    await save(
      [
        card({
          status: TransactionStatuses.Completed,
          processedDate: CHARGE,
          uniqueId: "s",
        }),
      ],
      {}, // clearOnChargeDate not set
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].date).toBe("2026-07-03"); // purchase date (UTC path, unchanged)
  });
});

describe("card lifecycle end-to-end: Isracard pending(named) -> FIBI charge date", () => {
  beforeEach(() => resetStore());

  it("enrichment sets the charge date; the named pending collapses to one cleared row on it", async () => {
    const cfg = { clearOnChargeDate: true };
    const named = (over: Partial<TransactionRow>) =>
      row({
        description: "רי באר",
        originalAmount: -28,
        originalCurrency: "ILS",
        chargedAmount: -28,
        date: "2026-07-29T13:00:00.000Z", // purchase
        processedDate: "2026-07-29T13:00:00.000Z",
        ...over,
      });

    // 1) Isracard pending (named) imports uncleared on the purchase date.
    await save(
      [named({ status: TransactionStatuses.Pending, uniqueId: "p" })],
      cfg,
    );
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false);
    expect(rows[0].date).toBe("2026-07-29");
    rows[0].category = "cat-groceries"; // human categorizes it

    // 2) Isracard settles with the WRONG monthly processedDate (08-19)...
    const settled = named({
      status: TransactionStatuses.Completed,
      processedDate: "2026-08-19T00:00:00.000Z",
      identifier: "V-RIBEER",
      uniqueId: "s",
    });
    // ...the FIBI drill-down enrichment rewrites it to the real charge date.
    const res = matchChargeDatesToGranular(
      [settled],
      [
        {
          purchaseDate: "29/07/2026",
          chargeDate: "31/07/2026",
          merchant: "רי באר ",
          dealAmount: 28,
          chargeAmount: 28,
        },
      ],
    );
    expect(res.updated).toBe(1);
    expect(settled.processedDate).toBe("2026-07-31T00:00:00.000Z");

    // 3) the settled row collapses onto the pending twin: one cleared row on the
    // real charge date, category preserved.
    await save([settled], cfg);
    rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].date).toBe("2026-07-31");
    expect(rows[0].category).toBe("cat-groceries");
  });
});

describe("ActualBudgetStorage excludeDescriptions", () => {
  beforeEach(() => resetStore());

  // The real case this exists for: the card posts every purchase individually
  // while the checking account posts one aggregate settlement line for the whole
  // bill. Both map to the same Actual account under the chosen model, so without
  // the exclusion every card purchase is counted twice.
  const AGGREGATE = "דירקט אושר-ישראכרט";
  // The bank truncates long descriptions, so the same line also appears shortened —
  // which is why the config takes a regex rather than an exact string.
  const AGGREGATE_TRUNCATED = "דירקט מטח אושר-ישרא";

  it("drops matching rows, keeps the rest, and counts them as skipped", async () => {
    const stats = await save(
      [
        row({ description: "UPSTASH", uniqueId: "u1" }),
        row({ description: AGGREGATE, chargedAmount: -4210.5, uniqueId: "u2" }),
        row({ description: "טורטיה בר חולון", uniqueId: "u3" }),
      ],
      { excludeDescriptions: ["אושר-ישרא"] },
    );

    expect(storeOf().map((r) => r.payee_name)).toEqual([
      "UPSTASH",
      "טורטיה בר חולון",
    ]);
    expect(stats.otherSkipped).toBe(1);
  });

  it("one pattern covers the truncated variant the bank also posts", async () => {
    await save(
      [
        row({ description: AGGREGATE, uniqueId: "u1" }),
        row({ description: AGGREGATE_TRUNCATED, uniqueId: "u2" }),
      ],
      { excludeDescriptions: ["אושר-ישרא"] },
    );
    expect(storeOf()).toHaveLength(0);
  });

  it("is a no-op when empty (the default)", async () => {
    await save([row({ description: AGGREGATE, uniqueId: "u1" })], {
      excludeDescriptions: [],
    });
    expect(storeOf()).toHaveLength(1);
  });

  it("applies on the standard non-upsert path too", async () => {
    const stats = await save(
      [
        row({ description: AGGREGATE, uniqueId: "u1" }),
        row({ description: "UPSTASH", uniqueId: "u2" }),
      ],
      { upsert: false, excludeDescriptions: ["אושר-ישרא"] },
    );
    expect(storeOf().map((r) => r.payee_name)).toEqual(["UPSTASH"]);
    expect(stats.otherSkipped).toBe(1);
  });

  it("matches case-insensitively and honors anchors", async () => {
    await save(
      [
        row({ description: "VISA SETTLEMENT", uniqueId: "u1" }),
        row({ description: "visa settlement", uniqueId: "u2" }),
        row({ description: "NOT A VISA SETTLEMENT SUFFIX", uniqueId: "u3" }),
      ],
      { excludeDescriptions: ["^visa settlement$"] },
    );
    expect(storeOf().map((r) => r.payee_name)).toEqual([
      "NOT A VISA SETTLEMENT SUFFIX",
    ]);
  });
});

describe("ActualBudgetStorage card-pending reconciliation (domestic, cross-source)", () => {
  beforeEach(() => resetStore());

  const cfg = {
    // Both the checking scrape (477872) and the card (0041) map to one Actual
    // account, as in the real config — that shared bucket is where the two
    // views of a card charge meet and reconcile.
    accounts: { "0041": "act-1", "477872": "act-1" },
    excludeDescriptions: ["מטח אושר-ישרא", "ישראכרט בע"],
    cardPendingDescriptions: ["אושר-ישראכרט"],
  };

  // FIBI per-purchase authorization: domestic, no merchant, from the checking scrape.
  const authorization = (over: Partial<TransactionRow> = {}) =>
    row({
      account: "477872",
      companyId: "beinleumi" as TransactionRow["companyId"],
      description: "דירקט אושר-ישראכרט",
      originalAmount: -169.9,
      originalCurrency: "ILS",
      chargedAmount: -169.9,
      status: TransactionStatuses.Pending,
      uniqueId: "fibi-auth",
      ...over,
    });
  // Isracard granular settled purchase for the same 169.90, a day later.
  const granular = (over: Partial<TransactionRow> = {}) =>
    row({
      account: "0041",
      companyId: "isracard" as TransactionRow["companyId"],
      description: "UPAPP",
      originalAmount: -169.9,
      originalCurrency: "ILS",
      chargedAmount: -169.9,
      status: TransactionStatuses.Completed,
      identifier: "V-UPAPP",
      uniqueId: "isracard-upapp",
      ...over,
    });

  it("imports the FIBI authorization as pending instead of excluding it", async () => {
    await save([authorization()], cfg);
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false);
    expect(rows[0].payee_name).toBe("דירקט אושר-ישראכרט");
    expect(rows[0].amount).toBe(-16990);
  });

  it("still excludes the FX hold and the settlement debit", async () => {
    const stats = await save(
      [
        authorization({ uniqueId: "a1" }),
        row({
          description: "דירקט מטח אושר-ישרא",
          chargedAmount: -3.39,
          uniqueId: "fx",
        }),
        row({
          description: '0041 - ישראכרט בע"מ',
          chargedAmount: -50,
          uniqueId: "settle",
        }),
      ],
      cfg,
    );
    expect(storeOf().map((r) => r.payee_name)).toEqual(["דירקט אושר-ישראכרט"]);
    expect(stats.otherSkipped).toBe(2);
  });

  it("settles the granular onto the authorization: one row, cleared, category kept", async () => {
    await save([authorization()], cfg);
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    rows[0].category = "cat-living"; // human categorizes the pending placeholder

    await save([granular()], cfg);
    rows = storeOf();
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].amount).toBe(-16990);
    expect(rows[0].category).toBe("cat-living"); // preserved across the supersede
  });

  it("does not double-count when authorization and granular arrive together", async () => {
    await save([authorization()], cfg); // placeholder exists
    await save([authorization(), granular()], cfg); // both in the next scrape
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
  });

  it("leaves the FX pending path untouched (non-ILS keeps the stable key)", async () => {
    // A foreign charge from Isracard must still reconcile on originalAmount, not
    // on the domestic card key — settlement moves chargedAmount but not the twin.
    await save(
      [row({ description: "UPSTASH", uniqueId: "fx-p" })], // USD pending, from the default row()
      cfg,
    );
    expect(storeOf()).toHaveLength(1);
    await save(
      [
        row({
          description: "UPSTASH",
          status: TransactionStatuses.Completed,
          chargedAmount: -59.2,
          identifier: "V",
          uniqueId: "fx-s",
        }),
      ],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1); // reconciled, not duplicated
    expect(rows[0].amount).toBe(-5920);
  });
});
