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
import { toJerusalemDate } from "./dates.js";

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
    expect(rows[0].notes).toBe(""); // owner-only field, sync writes empty
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
    expect(rows[0].notes).toBe(""); // notes left to the owner
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
    expect(rows[0].notes).toBe(""); // notes left to the owner
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

  it("leaves the notes field empty on collapse (owner-only)", async () => {
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
    expect(rows[0].notes).toBe(""); // notes left to the owner
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

describe("ActualBudgetStorage clearOnChargeDate future-charge guard (#14)", () => {
  beforeEach(() => resetStore());

  // Relative dates so the future/past split stays valid over time. Margins are
  // wide enough (>=2 days) to avoid TZ-midnight edge flakiness.
  const DAY = 86_400_000;
  const isoOffset = (days: number) =>
    new Date(Date.now() + days * DAY).toISOString();
  const cfg = { clearOnChargeDate: true };

  const cardCharge = (over: Partial<TransactionRow>) =>
    row({
      description: "טעינות-חבר של קבע",
      originalAmount: -692,
      originalCurrency: "ILS",
      chargedAmount: -692,
      status: TransactionStatuses.Completed,
      ...over,
    });

  it("(a) future charge date -> uncleared, dated on the purchase date, PENDING note", async () => {
    const purchase = isoOffset(-20);
    await save(
      [
        cardCharge({
          date: purchase,
          processedDate: isoOffset(16), // future monthly placeholder
          uniqueId: "future",
        }),
      ],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false); // NOT prematurely cleared
    expect(rows[0].date).toBe(toJerusalemDate(purchase)); // purchase, not the future date
    expect(rows[0].notes).toBe(""); // owner-only field, sync writes empty
  });

  it("(b) past charge date -> cleared on the real charge date", async () => {
    const purchase = isoOffset(-20);
    const charge = isoOffset(-4);
    await save(
      [cardCharge({ date: purchase, processedDate: charge, uniqueId: "past" })],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].date).toBe(toJerusalemDate(charge));
  });

  it("(c) collapses onto the settled twin once charged: one row, cleared, real date, category kept", async () => {
    const purchase = isoOffset(-20);
    const base = {
      description: "Upapp",
      originalAmount: -25,
      originalCurrency: "ILS",
      chargedAmount: -25,
      date: purchase,
    } as Partial<TransactionRow>;

    // Day 1: FIBI still holds it -> future monthly placeholder -> uncleared.
    await save(
      [cardCharge({ ...base, processedDate: isoOffset(16), uniqueId: "c1" })],
      cfg,
    );
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false);
    rows[0].category = "cat-x"; // human categorizes the pending placeholder

    // Later: FIBI posted -> enrichment stamped the real (past) charge date.
    const charge = isoOffset(-2);
    await save(
      [cardCharge({ ...base, processedDate: charge, uniqueId: "c2" })],
      cfg,
    );
    rows = storeOf();
    expect(rows).toHaveLength(1); // collapsed, no duplicate
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].date).toBe(toJerusalemDate(charge));
    expect(rows[0].category).toBe("cat-x");
  });

  it("(d) default-off: a future-dated completed card charge is unaffected", async () => {
    const purchase = isoOffset(-20);
    await save(
      [
        cardCharge({
          date: purchase,
          processedDate: isoOffset(16),
          uniqueId: "d",
        }),
      ],
      {}, // clearOnChargeDate not set
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true); // upstream behavior: completed -> cleared
    expect(rows[0].date).toBe(new Date(purchase).toISOString().split("T")[0]);
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

describe("ActualBudgetStorage anchorFxToFibi", () => {
  beforeEach(() => resetStore());

  // FIBI's excluded FX auth hold (amount source only): beinleumi + pending +
  // "מטח אושר", ILS-only, on the checking account.
  const fibiFxAuth = (over: Partial<TransactionRow> = {}) =>
    row({
      account: "477872",
      companyId: "beinleumi" as TransactionRow["companyId"],
      description: "דירקט מטח אושר-ישרא",
      originalCurrency: "ILS",
      originalAmount: -63.58,
      chargedAmount: -63.58, // FIBI's re-quoted ILS
      status: TransactionStatuses.Pending,
      uniqueId: "fibi-fx",
      ...over,
    });
  // Isracard FX pending charge: €20, Isracard's provisional ₪61.14.
  const isracardFx = (over: Partial<TransactionRow> = {}) =>
    row({
      account: "0041",
      description: "UPSTASH",
      originalAmount: -20,
      originalCurrency: "EUR",
      chargedAmount: -61.14,
      status: TransactionStatuses.Pending,
      uniqueId: "isr-fx-p",
      ...over,
    });

  const cfg = {
    anchorFxToFibi: true,
    excludeDescriptions: ["מטח אושר"], // FIBI auth is source-only, never imported
  };

  it("overrides the Isracard FX pending ILS with FIBI's auth amount, name/original untouched", async () => {
    await save([fibiFxAuth(), isracardFx()], cfg);
    const rows = storeOf();
    expect(rows).toHaveLength(1); // FIBI auth excluded, only the Isracard row imported
    expect(rows[0].payee_name).toBe("UPSTASH"); // merchant unchanged
    expect(rows[0].amount).toBe(-6358); // ILS anchored to FIBI (was -6114)
    expect(rows[0].cleared).toBe(false);
  });

  it("flag off (pending FX): keeps Isracard's provisional ILS", async () => {
    await save([fibiFxAuth(), isracardFx()], {
      excludeDescriptions: ["מטח אושר"], // still exclude the auth, just don't anchor
    });
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(-6114); // unchanged Isracard estimate
  });

  it("(a) COMPLETED FX + FIBI still holding -> kept UNCLEARED at FIBI's hold amount", async () => {
    // Isracard has settled (₪61.14) but FIBI is still holding the auth (₪63.58);
    // match FIBI and keep it pending until FIBI posts it.
    await save(
      [
        fibiFxAuth(),
        isracardFx({
          status: TransactionStatuses.Completed,
          chargedAmount: -61.14,
          identifier: "V",
          uniqueId: "isr-fx-s",
        }),
      ],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false); // kept pending — FIBI still holds it
    expect(rows[0].amount).toBe(-6358); // FIBI's hold amount, not Isracard's -6114
    expect(rows[0].notes).toBe(""); // owner-only field, sync writes empty
    expect(rows[0].imported_id.startsWith("pend:sig_")).toBe(true);
    expect(rows[0].payee_name).toBe("UPSTASH"); // merchant untouched
  });

  it("(b) COMPLETED FX + NO matching FIBI auth -> clears at Isracard's settled amount", async () => {
    // No FIBI auth present (posted / never held) -> today's behavior.
    await save(
      [
        isracardFx({
          status: TransactionStatuses.Completed,
          chargedAmount: -61.14,
          identifier: "V",
          uniqueId: "isr-fx-s",
        }),
      ],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].amount).toBe(-6114); // Isracard settled
  });

  it("(c) transition: FIBI-held completed FX then FIBI posts -> one row flips to cleared, no dupe", async () => {
    // Run 1: Isracard settled but FIBI still holding -> uncleared at ₪63.58.
    await save(
      [
        fibiFxAuth(),
        isracardFx({
          status: TransactionStatuses.Completed,
          chargedAmount: -61.14,
          identifier: "V",
          uniqueId: "isr-fx-s1",
        }),
      ],
      cfg,
    );
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false);
    expect(rows[0].amount).toBe(-6358);
    rows[0].category = "cat-travel";

    // Run 2: FIBI has posted it (auth gone) -> settles at Isracard's ₪61.14,
    // collapses the kept-pending row via the pend:sig_ key.
    await save(
      [
        isracardFx({
          status: TransactionStatuses.Completed,
          chargedAmount: -61.14,
          identifier: "V",
          uniqueId: "isr-fx-s2",
        }),
      ],
      cfg,
    );
    rows = storeOf();
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].amount).toBe(-6114); // true settled amount
    expect(rows[0].category).toBe("cat-travel"); // preserved
  });

  it("(d) domestic Completed charge is unaffected (not FX)", async () => {
    await save(
      [
        fibiFxAuth(),
        isracardFx({
          originalCurrency: "ILS",
          originalAmount: -130,
          chargedAmount: -130,
          status: TransactionStatuses.Completed,
          identifier: "V",
          uniqueId: "dom",
        }),
      ],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true); // domestic completed clears normally
    expect(rows[0].amount).toBe(-13000);
  });

  it("(e) flag off: a FIBI-held completed FX clears at Isracard's amount", async () => {
    await save(
      [
        fibiFxAuth(),
        isracardFx({
          status: TransactionStatuses.Completed,
          chargedAmount: -61.14,
          identifier: "V",
          uniqueId: "isr-fx-s",
        }),
      ],
      { excludeDescriptions: ["מטח אושר"] }, // anchorFxToFibi off
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].amount).toBe(-6114);
  });

  it("(f) anchored pending still collapses onto the settled €20 twin (no dupe)", async () => {
    // 1) FX pending anchored to FIBI's ₪63.58
    await save([fibiFxAuth(), isracardFx()], cfg);
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(-6358);
    rows[0].category = "cat-travel";

    // 2) it settles at Isracard's final ₪59.20 (auth gone) -> collapse via the
    //    FX-stable key (originalAmount €20 + EUR + account), one row.
    await save(
      [
        isracardFx({
          status: TransactionStatuses.Completed,
          chargedAmount: -59.2,
          identifier: "V",
          uniqueId: "isr-fx-s",
        }),
      ],
      cfg,
    );
    rows = storeOf();
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].amount).toBe(-5920); // final settled ILS
    expect(rows[0].category).toBe("cat-travel"); // preserved
  });
});

describe("ActualBudgetStorage clearOnFibiSettlement", () => {
  beforeEach(() => resetStore());

  const cfg = { clearOnFibiSettlement: true };

  // Relative dates so the "older than the settle lag" boundary stays valid over
  // time. RECENT (< FIBI_SETTLE_LAG_DAYS) stays uncleared while it has not appeared
  // on FIBI; OLD (>= lag) clears via the 0041-only settle fallback (never 5104).
  const DAY = 86_400_000;
  const isoOffset = (days: number) =>
    new Date(Date.now() + days * DAY).toISOString();
  const RECENT = isoOffset(-1); // < 5-day lag
  const OLD = isoOffset(-10); // >= 5-day lag
  const CHARGE = isoOffset(-3); // a past FIBI charge date

  // A domestic Isracard card charge (isCardCharge via companyId). Default account
  // "0041" (direct debit). Default processedDate is the FUTURE monthly placeholder
  // the scraper reports.
  const cardTx = (over: Partial<TransactionRow>) =>
    row({
      description: "Upapp",
      originalCurrency: "ILS",
      originalAmount: -100,
      chargedAmount: -100,
      status: TransactionStatuses.Completed,
      date: RECENT,
      processedDate: isoOffset(15),
      ...over,
    });

  // A FIBI domestic auth-hold ("דירקט אושר-ישראכרט") for the same |amount|, from
  // the checking scrape. Excluded from import; used only as an "on FIBI" signal.
  const fibiHold = (over: Partial<TransactionRow> = {}) =>
    row({
      account: "477872",
      companyId: "beinleumi" as TransactionRow["companyId"],
      description: "דירקט אושר-ישראכרט",
      originalCurrency: "ILS",
      originalAmount: -100,
      chargedAmount: -100,
      status: TransactionStatuses.Pending,
      date: RECENT,
      uniqueId: "fibi-hold",
      ...over,
    });

  it("(a) bank-settled granular clears on the FIBI charge date, regardless of age", async () => {
    // RECENT purchase: without the mark it would stay pending, but bankSettled
    // clears it precisely on the FIBI charge date.
    await save(
      [cardTx({ bankSettled: true, processedDate: CHARGE, uniqueId: "a" })],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].date).toBe(toJerusalemDate(CHARGE)); // FIBI charge date
  });

  it("(b) unmatched RECENT granular stays uncleared on the purchase date at Isracard's amount", async () => {
    await save([cardTx({ uniqueId: "b" })], cfg); // no bankSettled mark, recent
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false); // FIBI hasn't posted it yet
    expect(rows[0].date).toBe(toJerusalemDate(RECENT)); // purchase date
    expect(rows[0].notes).toBe(""); // owner-only field, sync writes empty
    expect(rows[0].amount).toBe(-10000); // Isracard's own amount
  });

  it("(lag) unmatched OLD 0041 charge clears via the 0041-only settle fallback", async () => {
    await save([cardTx({ date: OLD, uniqueId: "lag" })], cfg); // 0041, unmatched, old
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true); // 0041 has certainly posted to FIBI by now
    expect(rows[0].date).toBe(toJerusalemDate(OLD)); // dated on the purchase date
  });

  it("(5104) unmatched OLD 5104 monthly charge stays UNCLEARED (not on FIBI yet)", async () => {
    // The reported bug: a 5104 monthly-credit charge does not appear on FIBI until
    // its statement, so the age fallback must NOT clear it — only 0041 ages out.
    await save([cardTx({ date: OLD, account: "5104", uniqueId: "m5104" })], {
      ...cfg,
      accounts: { "0041": "act-1", "5104": "act-1" },
    });
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false); // stays uncleared until the monthly statement
    expect(rows[0].date).toBe(toJerusalemDate(OLD)); // on the purchase date
  });

  it("(hold) recent 0041 charge FIBI is auth-HOLDING becomes CLEARED", async () => {
    // The other reported bug: a recent 0041 charge FIBI is currently holding was
    // left uncleared because domestic holds were not detected. Now it clears. The
    // FIBI auth is excluded from import (as in the live config) but pooled as the
    // "on FIBI" signal.
    await save([cardTx({ uniqueId: "h" }), fibiHold({ uniqueId: "h-hold" })], {
      ...cfg,
      excludeDescriptions: ["אושר-ישרא"],
    });
    const rows = storeOf();
    expect(rows).toHaveLength(1); // the FIBI auth is excluded, not imported
    expect(rows[0].payee_name).toBe("Upapp");
    expect(rows[0].cleared).toBe(true); // appears on FIBI as a live hold -> cleared
    expect(rows[0].date).toBe(toJerusalemDate(RECENT)); // purchase date
    expect(rows[0].amount).toBe(-10000);
  });

  it("(hold) the unified rule is not card-type-branched: a held 5104 charge clears too", async () => {
    // If FIBI is already holding a 5104 charge, it IS on FIBI -> cleared, even
    // though the age fallback would never clear a 5104. Same "appears on FIBI" check.
    await save(
      [
        cardTx({ account: "5104", uniqueId: "h5" }),
        fibiHold({ uniqueId: "h5-hold" }),
      ],
      {
        ...cfg,
        accounts: { "5104": "act-1" },
        excludeDescriptions: ["אושר-ישרא"],
      },
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
  });

  it("(hold) a domestic hold does not clear a charge with a different amount", async () => {
    await save(
      [
        cardTx({ chargedAmount: -250, originalAmount: -250, uniqueId: "hx" }),
        fibiHold({ uniqueId: "hx-hold" }), // holds ₪100, not ₪250
      ],
      { ...cfg, excludeDescriptions: ["אושר-ישרא"] },
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false); // no matching hold, recent, not aged -> uncleared
  });

  it("(c) unmatched RECENT -> matched next run flips to cleared: single row, no dupe", async () => {
    await save([cardTx({ uniqueId: "c" })], cfg); // unmatched recent -> uncleared
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(false);
    rows[0].category = "cat-x";

    // Next run: FIBI posted it -> enrichment marks it bank-settled with the real
    // charge date; collapses via the pend:sig_ key.
    await save(
      [cardTx({ bankSettled: true, processedDate: CHARGE, uniqueId: "c" })],
      cfg,
    );
    rows = storeOf();
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].date).toBe(toJerusalemDate(CHARGE));
    expect(rows[0].category).toBe("cat-x");
  });

  it("(d) an already-cleared row stays cleared when a later run reports it unmatched (idempotent)", async () => {
    // Run 1: matched -> cleared, imported under its settledImportedId.
    await save(
      [cardTx({ bankSettled: true, processedDate: CHARGE, uniqueId: "d" })],
      cfg,
    );
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
    const importedId = rows[0].imported_id;

    // Run 2: same charge, RECENT + now UNMATCHED (window didn't re-drill) -> the
    // pending path must not thrash it back to uncleared / duplicate it.
    await save([cardTx({ uniqueId: "d" })], cfg);
    rows = storeOf();
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].cleared).toBe(true); // stays cleared (posted stays posted)
    expect(rows[0].imported_id).toBe(importedId);
  });

  it("(e) flag off: a completed card charge clears normally on the purchase date", async () => {
    await save([cardTx({ bankSettled: true, uniqueId: "e" })], {}); // flag off
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true);
    // upstream path: completed -> cleared, dated (UTC) on the purchase date
    expect(rows[0].date).toBe(new Date(RECENT).toISOString().split("T")[0]);
  });

  it("(e) non-card completed charge is unaffected by the flag", async () => {
    await save(
      [
        row({
          account: "477872",
          companyId: "beinleumi" as TransactionRow["companyId"],
          description: "משכורת",
          originalCurrency: "ILS",
          originalAmount: 5000,
          chargedAmount: 5000,
          status: TransactionStatuses.Completed,
          uniqueId: "sal",
        }),
      ],
      { clearOnFibiSettlement: true, accounts: { "477872": "act-1" } },
    );
    const rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true); // non-card clears normally
  });
});

describe("ActualBudgetStorage FIBI-direct non-card credit dedup (pending->settled)", () => {
  beforeEach(() => resetStore());

  // The recurring bug: a FIBI-direct National-Insurance / reserve-duty credit
  // ("ביטוח לאומי מיל") first appears value-dated ("*יזום", posts next business
  // day) with no reference, then settles with a late-assigned identifier. Its
  // moneyman uniqueId therefore differs between the two views, so hash(uniqueId)
  // -> settledImportedId differs and the settled twin imported as a SECOND row.
  // Under clearOnFibiSettlement it clears immediately (it is on FIBI), so it
  // must anchor to its stable pend:sig_ signature key to collapse to ONE row.
  const cfg = { clearOnFibiSettlement: true, accounts: { "477872": "act-1" } };

  // A FIBI checking-account (beinleumi) NON-card credit. Positive amount.
  const credit = (over: Partial<TransactionRow>) =>
    row({
      account: "477872",
      companyId: "beinleumi" as TransactionRow["companyId"],
      description: "ביטוח לאומי מיל",
      originalCurrency: "ILS",
      originalAmount: 888,
      chargedAmount: 888,
      date: "2026-08-16T21:00:00.000Z", // 21:00Z == midnight Israel -> 2026-08-17
      processedDate: "2026-08-16T21:00:00.000Z",
      ...over,
    });

  it("ביטוח לאומי: pending (no ref) then settled (ref assigned) collapses to ONE cleared row", async () => {
    // 1) value-dated pending view: identifier absent -> uniqueId from desc+memo.
    await save(
      [credit({ status: TransactionStatuses.Pending, uniqueId: "bi-pending" })],
      cfg,
    );
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared).toBe(true); // appears on FIBI -> cleared even while pending
    expect(rows[0].amount).toBe(88800);
    // Anchored to the stable signature key, NOT the volatile settledImportedId.
    expect(rows[0].imported_id.startsWith("pend:sig_")).toBe(true);
    const stableId = rows[0].imported_id;

    // owner categorizes it
    rows[0].category = "cat-income";

    // 2) settled view: a reference is now assigned -> a DIFFERENT uniqueId.
    await save(
      [
        credit({
          status: TransactionStatuses.Completed,
          identifier: "REF-889900",
          uniqueId: "bi-settled",
        }),
      ],
      cfg,
    );
    rows = storeOf();
    expect(rows).toHaveLength(1); // no duplicate (the bug: this used to be 2)
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].imported_id).toBe(stableId); // identity stayed on the stable key
    expect(rows[0].category).toBe("cat-income"); // category preserved
  });

  it("collapses to ONE row even when FIBI re-stamps the value date on settle", async () => {
    await save(
      [credit({ status: TransactionStatuses.Pending, uniqueId: "d-pending" })],
      cfg,
    );
    expect(storeOf()).toHaveLength(1);

    // settled a day later (FIBI drifts the value date within the collapse window)
    await save(
      [
        credit({
          status: TransactionStatuses.Completed,
          identifier: "REF-DRIFT",
          uniqueId: "d-settled",
          date: "2026-08-17T21:00:00.000Z", // -> 2026-08-18 Israel (1 day drift)
          processedDate: "2026-08-17T21:00:00.000Z",
        }),
      ],
      cfg,
    );
    expect(storeOf()).toHaveLength(1); // still one row across the date drift
  });

  it("two genuinely-distinct same-amount credits on different dates stay TWO rows", async () => {
    // Both +888, but 10 days apart -> outside the collapse window -> not merged.
    await save(
      [
        credit({
          status: TransactionStatuses.Completed,
          identifier: "REF-A",
          uniqueId: "c-a",
          date: "2026-08-16T21:00:00.000Z", // -> 2026-08-17
        }),
      ],
      cfg,
    );
    await save(
      [
        credit({
          status: TransactionStatuses.Completed,
          identifier: "REF-B",
          uniqueId: "c-b",
          date: "2026-08-26T21:00:00.000Z", // -> 2026-08-27 (10 days later)
        }),
      ],
      cfg,
    );
    const rows = storeOf();
    expect(rows).toHaveLength(2); // distinct credits are not over-collapsed
  });

  it("is idempotent: re-scraping the settled credit changes nothing", async () => {
    const settled = () =>
      credit({
        status: TransactionStatuses.Completed,
        identifier: "REF-IDEM",
        uniqueId: "idem",
      });
    await save([settled()], cfg);
    let rows = storeOf();
    expect(rows).toHaveLength(1);
    const before = { ...rows[0] };

    await save([settled()], cfg);
    rows = storeOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].imported_id).toBe(before.imported_id);
    expect(rows[0].cleared).toBe(true);
    expect(rows[0].amount).toBe(before.amount);
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
