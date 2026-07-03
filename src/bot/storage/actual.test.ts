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

const storeOf = () => (actualApi as any).__store() as any[];
const resetStore = () => (actualApi as any).__reset();

function makeConfig(): MoneymanConfig {
  return {
    storage: {
      actual: {
        serverUrl: "http://actual:5006",
        password: "p",
        budgetId: "b",
        accounts: { "0041": "act-1" },
        keepPending: true,
        upsert: true,
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

async function save(txns: TransactionRow[]) {
  const storage = new ActualBudgetStorage(makeConfig());
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
