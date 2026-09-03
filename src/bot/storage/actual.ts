import * as actualApi from "@actual-app/api";
import type { ImportTransactionEntity } from "@actual-app/core/@types/src/types/models/index.js";
import { hash } from "hash-it";
import { CompanyTypes } from "israeli-bank-scrapers";
import { TransactionStatuses } from "israeli-bank-scrapers/lib/transactions.js";
import assert from "node:assert";
import fs from "node:fs/promises";
import * as os from "os";
import * as path from "path";
import type { MoneymanConfig } from "../../config.js";
import { TransactionRow, TransactionStorage } from "../../types.js";
import { createLogger } from "../../utils/logger.js";
import { formatUnknownError } from "../../utils/utils.js";
import { createSaveStats, SaveStats } from "../saveStats.js";
import {
  computeCardKey,
  computeStableKey,
  planActualUpsert,
  type ExistingActualTx,
  type IncomingTx,
} from "./actualUpsert.js";
import { toJerusalemDate } from "./dates.js";
import { assignFxAnchors, type FibiAuth } from "./fxAnchor.js";

const logger = createLogger("ActualBudgetStorage");

// FIBI posts card 0041 (direct-debit) settlements within ~2-3 days of the charge.
// Under `clearOnFibiSettlement`, the authoritative "appears on FIBI" signals are a
// settlement drill-down match (`bankSettled`) and a live domestic auth-hold match
// (`fibiDomesticHolds`). This lag is a NARROW SAFETY FALLBACK, gated to card 0041
// ONLY (see `isCard0041`): a direct-debit charge reliably posts within ~2-3 days,
// so if BOTH signals miss it (drill-down outside the scrape window AND the hold
// already released) and it is at least this many days old, it has certainly
// posted — clear it so the unconfirmable 0041 tail never breaks the reconciliation
// formula. NEVER applied to card 5104 (monthly credit): a 5104 charge does not
// appear on FIBI until its monthly statement, so ageing it out would clear it
// ahead of FIBI. `bankSettled` always wins (precise charge date); this is a floor.
const FIBI_SETTLE_LAG_DAYS = 5;

// A FIBI domestic auth-hold appears within ~2-3 days of the purchase; allow a few
// extra days of slack (and TZ slack the other way) when matching a hold to a
// charge by |amount| + date. Global best-pair (nearest date) + consume-once keeps
// same-amount collisions safe.
const DOMESTIC_HOLD_WINDOW_DAYS = 5;

/** Whole-day (today − date) in Asia/Jerusalem calendar days; negative if future. */
function daysAgo(date: string, today: string): number {
  return (
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
    86_400_000
  );
}

export class ActualBudgetStorage implements TransactionStorage {
  private bankToActualAccountMap = new Map<string, string>();
  private accountIdToNameMap = new Map<string, string>();
  private excludeRes?: RegExp[];
  private cardPendingRes?: RegExp[];
  // Per-save FX-anchor overrides: an Isracard FX pending row -> the ILS amount
  // (integer minor units) taken from FIBI's auth hold. Empty unless
  // `anchorFxToFibi` is on. Keyed by identity so no other storage is affected.
  private fxOverrides = new Map<TransactionRow, number>();
  // Per-save set of DOMESTIC card charges that FIBI is currently auth-HOLDING (a
  // FIBI "דירקט אושר-ישראכרט" domestic auth matched by |amount| + date). Under the
  // unified `clearOnFibiSettlement` rule a charge that appears on FIBI — as a
  // settlement OR a hold — is CLEARED. Empty unless `clearOnFibiSettlement` is on.
  // Keyed by identity so no other storage is affected. This is the domestic analog
  // of `fxOverrides`, but it CLEARS the charge (domestic amount is final) rather
  // than keeping it pending the way the FX hold path does (FX amount still moves).
  private fibiDomesticHolds = new Set<TransactionRow>();
  // payee name -> id cache for the placeholder-payee refresh (lazy-loaded).
  private payeeIdByName = new Map<string, string>();

  constructor(private config: MoneymanConfig) {}

  /** Find-or-create a payee id for a name (cached). Used only to apply a
   * placeholder-payee refresh update. */
  private async resolvePayeeId(name: string): Promise<string> {
    if (this.payeeIdByName.size === 0) {
      for (const p of await actualApi.getPayees())
        if (p?.name) this.payeeIdByName.set(p.name, p.id);
    }
    const hit = this.payeeIdByName.get(name);
    if (hit) return hit;
    const id = await actualApi.createPayee({ name });
    this.payeeIdByName.set(name, id);
    return id;
  }

  canSave() {
    return Boolean(this.config.storage.actual);
  }

  async saveTransactions(
    txns: Array<TransactionRow>,
    onProgress: (status: string) => Promise<void>,
  ): Promise<SaveStats> {
    await Promise.all([onProgress("Initializing"), this.init()]);

    const stats = createSaveStats(
      "ActualBudgetStorage",
      `budget: "${this.config.storage.actual?.budgetId || "unknown"}"`,
      txns,
    );

    try {
      // Collect FIBI FX auth amounts from the FULL set BEFORE exclusions drop
      // them (they stay excluded — used only as an amount source), then compute
      // per-row overrides. Off by default -> empty map -> no behavior change.
      this.fxOverrides = this.config.storage.actual?.anchorFxToFibi
        ? this.computeFxAnchors(txns)
        : new Map();

      // Which domestic card charges FIBI is currently holding as an auth. Pooled
      // from the FULL set BEFORE exclusions (the FIBI auth rows are excluded from
      // import but used here as a "appears on FIBI" signal, exactly like the FX
      // auth pool above). Off unless `clearOnFibiSettlement` -> empty -> no-op.
      this.fibiDomesticHolds = this.config.storage.actual?.clearOnFibiSettlement
        ? this.computeDomesticHolds(txns)
        : new Set();

      const kept = this.applyDescriptionExclusions(txns, stats);

      if (this.config.storage.actual?.upsert) {
        await this.upsertTransactions(kept, stats, onProgress);
        return stats;
      }

      const keepPending = Boolean(this.config.storage.actual?.keepPending);
      const transactionsByActualAccountId = new Map<
        string,
        ImportTransactionEntity[]
      >();

      for (let tx of kept) {
        const isPending = tx.status === TransactionStatuses.Pending;
        if (isPending && !keepPending) {
          continue;
        }

        const actualAccountId = this.bankToActualAccountMap.get(tx.account);
        if (!actualAccountId) {
          stats.otherSkipped++;
          continue;
        }

        const actualTx = this.convertTransactionToActualFormat(
          tx,
          actualAccountId,
        );

        if (!transactionsByActualAccountId.has(actualAccountId)) {
          transactionsByActualAccountId.set(actualAccountId, []);
        }
        transactionsByActualAccountId.get(actualAccountId)!.push(actualTx);
      }

      if (transactionsByActualAccountId.size > 0) {
        await this.sendTransactionsToActual(
          transactionsByActualAccountId,
          stats,
          onProgress,
        );
      }
    } finally {
      await actualApi.shutdown();
    }
    return stats;
  }

  private async sendTransactionsToActual(
    transactionsByActualAccountId: Map<string, ImportTransactionEntity[]>,
    stats: SaveStats,
    onProgress: (status: string) => Promise<void>,
  ) {
    logger(
      `sending to Actual budget: "${this.config.storage.actual?.budgetId}"`,
    );

    try {
      for (const [
        actualAccountId,
        transactions,
      ] of transactionsByActualAccountId) {
        const accountName =
          this.accountIdToNameMap.get(actualAccountId) || actualAccountId;
        logger(
          `Processing ${transactions.length} transactions for account "${accountName}"`,
        );
        const [importResponse] = await Promise.all([
          actualApi
            .importTransactions(actualAccountId, transactions)
            .catch((error) => {
              logger(
                `Error importing transactions for account "${accountName}": ${error.message}`,
              );
              return {
                errors: [error.message],
                added: [],
                updated: [],
              };
            }),
          onProgress(`Sending transactions for account "${accountName}"`),
        ]);

        if (importResponse.errors?.length) {
          logger(
            `Errors importing transactions: ${JSON.stringify(importResponse.errors)}`,
          );
          continue;
        }

        logger(
          `Imported ${importResponse.added?.length || 0} transactions for account "${accountName}"`,
        );
        stats.added += importResponse.added?.length || 0;
        stats.existing += importResponse.updated?.length || 0;
      }

      logger("transactions sent to Actual successfully!");

      if (this.config.options.scraping.transactionHashType !== "moneyman") {
        logger("Warning: transactionHashType should be set to 'moneyman'");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to send transactions to Actual: ${message}`);
    }
  }

  private async init() {
    logger("init");
    const actualConfig = this.config.storage.actual;
    assert(actualConfig, "Actual storage is not configured");

    try {
      const tempDir = path.join(os.tmpdir(), "moneyman-actual-data");
      const dirExists = await fs.stat(tempDir).catch(() => false);
      if (!dirExists) {
        await fs.mkdir(tempDir, { recursive: true });
      }

      await actualApi.init({
        dataDir: tempDir,
        serverURL: actualConfig.serverUrl,
        password: actualConfig.password,
      });

      await actualApi.downloadBudget(actualConfig.budgetId);

      const actualAccounts = await actualApi.getAccounts();
      const validActualAccountIds = new Set(actualAccounts.map((a) => a.id));
      this.accountIdToNameMap = new Map(
        actualAccounts.map((a) => [a.id, a.name]),
      );

      this.bankToActualAccountMap = new Map(
        Object.entries(actualConfig.accounts),
      );

      for (const [
        bankAccountId,
        actualAccountId,
      ] of this.bankToActualAccountMap.entries()) {
        if (!validActualAccountIds.has(actualAccountId)) {
          const accountName =
            this.accountIdToNameMap.get(actualAccountId) || actualAccountId;
          logger(
            `Warning: Actual Budget account "${accountName}" for bank account ${bankAccountId} does not exist`,
          );
          this.bankToActualAccountMap.delete(bankAccountId);
        }
      }

      if (this.bankToActualAccountMap.size === 0) {
        throw new Error(
          "No valid account mappings found. Please check ACTUAL_ACCOUNTS configuration.",
        );
      }
    } catch (error) {
      throw new Error(
        `Failed to initialize Actual Budget: ${formatUnknownError(error)}`,
      );
    }
  }

  private excludePatterns(): RegExp[] {
    if (!this.excludeRes) {
      this.excludeRes = (
        this.config.storage.actual?.excludeDescriptions ?? []
      ).map((p) => new RegExp(p, "i"));
    }
    return this.excludeRes;
  }

  /**
   * Drop transactions whose description matches `actual.excludeDescriptions`
   * (opt-in; empty by default, in which case this is a no-op).
   *
   * Needed when a card and the checking account it settles against both map to
   * the same Actual account. The bank posts an aggregate settlement line for the
   * whole card bill, which would double-count the card's own per-purchase rows.
   * Excluding it by description keeps the granular rows as the single source.
   */
  private applyDescriptionExclusions(
    txns: Array<TransactionRow>,
    stats: SaveStats,
  ): Array<TransactionRow> {
    const patterns = this.excludePatterns();
    if (patterns.length === 0) {
      return txns;
    }

    const kept: TransactionRow[] = [];
    for (const tx of txns) {
      // A card-pending authorization we intend to reconcile is never dropped,
      // even if an excludeDescriptions pattern would also match it.
      if (this.cardPendingPatterns().some((re) => re.test(tx.description))) {
        kept.push(tx);
        continue;
      }
      const matched = patterns.find((re) => re.test(tx.description));
      if (matched) {
        logger(
          `excluded "${tx.description}" (${tx.chargedAmount}) — matched /${matched.source}/`,
        );
        stats.otherSkipped++;
        continue;
      }
      kept.push(tx);
    }

    const excluded = txns.length - kept.length;
    if (excluded > 0) {
      logger(`excluded ${excluded} transaction(s) by description`);
    }
    return kept;
  }

  private convertTransactionToActualFormat(
    tx: TransactionRow,
    actualAccountId: string,
  ): ImportTransactionEntity {
    const amount = this.actualAmount(tx);

    return {
      account: actualAccountId,
      date: new Date(tx.date).toISOString().split("T")[0],
      amount,
      payee_name: tx.description,
      cleared: tx.status === TransactionStatuses.Completed,
      imported_id: this.settledImportedId(tx),
      notes: tx.memo,
    };
  }

  // The imported_id used once a transaction has settled — moneyman's existing
  // uniqueId/voucher-based hash, so upsert-imported rows stay idempotent with any
  // rows imported via the standard path.
  private settledImportedId(tx: TransactionRow): string {
    return hash(
      this.config.options.scraping.transactionHashType === "moneyman"
        ? tx.uniqueId
        : tx.hash,
    ).toString();
  }

  private cardPendingPatterns(): RegExp[] {
    if (!this.cardPendingRes) {
      this.cardPendingRes = (
        this.config.storage.actual?.cardPendingDescriptions ?? []
      ).map((p) => new RegExp(p, "i"));
    }
    return this.cardPendingRes;
  }

  /**
   * A domestic (ILS) card charge has two views that must reconcile: the bank's
   * per-purchase pending authorization (description matches a configured
   * pattern) and the card issuer's settled granular row (companyId isracard).
   * They share only amount + date, so they take the card key rather than the FX
   * stable key. FX charges (non-ILS) are excluded — their reconciliation depends
   * on the original-currency key, which must not change.
   */
  private isDomesticCardCharge(tx: TransactionRow): boolean {
    const patterns = this.cardPendingPatterns();
    if (patterns.length === 0) return false;
    const domestic = !tx.originalCurrency || tx.originalCurrency === "ILS";
    if (!domestic) return false;
    return (
      patterns.some((re) => re.test(tx.description)) ||
      tx.companyId === CompanyTypes.isracard
    );
  }

  /**
   * A card-issuer charge whose real clearing date is the bank CHARGE date, not
   * the purchase date. Broader than `isDomesticCardCharge` (which gates the
   * legacy FIBI-auth<->Isracard card-key matcher on `cardPendingDescriptions`):
   * charge-date clearing applies to any card-issuer row, so it is keyed off the
   * company rather than that opt-in config.
   */
  private isCardCharge(tx: TransactionRow): boolean {
    return (
      tx.companyId === CompanyTypes.isracard || this.isDomesticCardCharge(tx)
    );
  }

  /**
   * A FIBI (beinleumi) FX auth hold — an excluded amount source for FX anchoring.
   * Carries only the ILS `chargedAmount` + date (originalCurrency is "ILS", no
   * merchant/identifier); description like "דירקט מטח אושר-ישרא".
   */
  private isFibiFxAuth(tx: TransactionRow): boolean {
    return (
      tx.companyId === CompanyTypes.beinleumi &&
      tx.status === TransactionStatuses.Pending &&
      /מטח אושר/.test(tx.description ?? "")
    );
  }

  /**
   * A FIBI (beinleumi) DOMESTIC card auth-hold — the per-purchase authorization
   * FIBI posts for a direct-debit (0041) card charge (description like
   * "דירקט אושר-ישראכרט"; ILS `chargedAmount`, no merchant). It is the domestic
   * twin of {@link isFibiFxAuth}; the two are distinguished by the "מטח" (FX)
   * token, which the domestic auth never carries. Used ONLY as an "appears on
   * FIBI" signal (never imported — it is excluded by description).
   */
  private isFibiDomesticAuth(tx: TransactionRow): boolean {
    const desc = tx.description ?? "";
    return (
      tx.companyId === CompanyTypes.beinleumi &&
      tx.status === TransactionStatuses.Pending &&
      /אושר/.test(desc) &&
      !/מטח/.test(desc)
    );
  }

  /**
   * The Isracard direct-debit card (0041): it posts to FIBI within ~2-3 days as an
   * auth-hold then a settlement. The monthly-credit card (5104) does NOT appear on
   * FIBI until its statement, so the age-based settle fallback must never apply to
   * it. The card number is the Isracard row's `account` (the config account key,
   * e.g. "0041"/"5104"); reliable per row, so the fallback can be gated on it.
   */
  private isCard0041(tx: TransactionRow): boolean {
    return (
      tx.companyId === CompanyTypes.isracard && (tx.account ?? "") === "0041"
    );
  }

  /**
   * Detect which DOMESTIC (ILS) card charges FIBI is currently auth-HOLDING, so
   * the unified `clearOnFibiSettlement` rule can clear them ("appears on FIBI as a
   * hold OR settlement -> cleared"). The domestic analog of {@link computeFxAnchors}:
   * pool the FIBI domestic auth-holds (amount source only — excluded from import),
   * then match each completed domestic card charge to a hold by |amount| + purchase
   * date. Domestic ILS amounts do NOT move between auth and settlement, so the
   * match is on EXACT integer minor units (unlike FX, which needs ratio bands).
   *
   * GLOBAL best-pair (nearest date first) with consume-once for both sides, so two
   * same-amount charges never both claim one hold. Returns the set of matched
   * charges (by identity). Pure w.r.t. the transactions (no mutation).
   */
  private computeDomesticHolds(
    txns: Array<TransactionRow>,
  ): Set<TransactionRow> {
    const matched = new Set<TransactionRow>();

    const holds = txns
      .filter((t) => this.isFibiDomesticAuth(t))
      .map((t) => ({
        amountMinor: Math.abs(actualApi.utils.amountToInteger(t.chargedAmount)),
        date: toJerusalemDate(t.date),
      }));
    if (holds.length === 0) return matched;

    // Eligible: completed domestic (ILS) card charges. FX charges are excluded —
    // their hold handling is the separate `fxOverrides` path (kept pending).
    const eligible = txns.filter(
      (tx) =>
        this.isCardCharge(tx) &&
        tx.status === TransactionStatuses.Completed &&
        (!tx.originalCurrency || tx.originalCurrency === "ILS"),
    );

    interface Pair {
      ci: number;
      hi: number;
      dist: number;
    }
    const pairs: Pair[] = [];
    eligible.forEach((tx, ci) => {
      const mag = Math.abs(actualApi.utils.amountToInteger(tx.chargedAmount));
      const date = toJerusalemDate(tx.date);
      holds.forEach((h, hi) => {
        if (h.amountMinor !== mag) return;
        const dist = Math.abs(daysAgo(h.date, date));
        if (dist <= DOMESTIC_HOLD_WINDOW_DAYS) pairs.push({ ci, hi, dist });
      });
    });

    const usedCharge = new Set<number>();
    const usedHold = new Set<number>();
    for (const p of pairs.sort((a, b) => a.dist - b.dist)) {
      if (usedCharge.has(p.ci) || usedHold.has(p.hi)) continue;
      usedCharge.add(p.ci);
      usedHold.add(p.hi);
      matched.add(eligible[p.ci]);
    }

    if (matched.size > 0) {
      logger(
        `fibi domestic holds: ${matched.size} card charge(s) matched a live FIBI auth-hold -> cleared`,
      );
    }
    return matched;
  }

  /**
   * Build FX-anchor overrides (opt-in via `anchorFxToFibi`): pool the FIBI FX
   * auth amounts (they stay excluded — used only as an amount source), then for
   * each Isracard FX charge pick the best matching auth and record its ILS amount
   * as the override. Consumable once each. `chargedAmount` is the only thing
   * overridden; originalAmount/currency/merchant are untouched, so the FX-stable
   * collapse key is unaffected.
   *
   * The principle: match FIBI whenever it is still HOLDING the charge as an auth
   * — a matched charge stays uncleared at FIBI's hold amount (see toIncoming's
   * `fibiHolding`), and only clears at the true settled amount once FIBI posts it
   * (its auth is gone -> no match). A PENDING Isracard charge is always eligible;
   * a COMPLETED one only when `upsert` is on (the collapse that later flips it to
   * settled lives on the upsert path — never keep a completed charge pending on
   * the non-upsert path, where it could not later settle).
   */
  private computeFxAnchors(
    txns: Array<TransactionRow>,
  ): Map<TransactionRow, number> {
    const overrides = new Map<TransactionRow, number>();
    const pool: FibiAuth[] = txns
      .filter((t) => this.isFibiFxAuth(t))
      .map((t) => ({
        amountMinor: actualApi.utils.amountToInteger(t.chargedAmount),
        date: toJerusalemDate(t.date),
      }));
    if (pool.length === 0) return overrides;

    const upsert = Boolean(this.config.storage.actual?.upsert);

    // Eligible FX charges: Isracard, non-ILS, and either pending or (completed
    // only when upsert can later collapse it to settled).
    const eligible = txns.filter(
      (tx) =>
        tx.companyId === CompanyTypes.isracard &&
        tx.originalCurrency &&
        tx.originalCurrency !== "ILS" &&
        (tx.status === TransactionStatuses.Pending || upsert),
    );

    // Assign holds to charges GLOBALLY (best-pair), not charge-by-charge in list
    // order — otherwise the first FX charge grabs a hold that fits a later one
    // better (the Google/Upstash ₪63.58 mis-assignment).
    const results = assignFxAnchors(
      eligible.map((tx) => ({
        originalCurrency: tx.originalCurrency!,
        chargedAmount: tx.chargedAmount,
        matchDate: toJerusalemDate(tx.date),
      })),
      pool,
    );

    eligible.forEach((tx, i) => {
      const res = results[i];
      const anchored = res.consumedAuthIndex !== null;
      if (anchored) overrides.set(tx, res.amountMinor);

      // One observability line per FX decision — a running dataset to confirm
      // (or refute) the ~4% FIBI/Isracard FX spread hypothesis, and to show the
      // hold/posted state we acted on.
      const ils = (m: number) => (Math.abs(m) / 100).toFixed(2);
      const state = anchored
        ? "anchored (fibi still holding, kept pending)"
        : tx.status === TransactionStatuses.Pending
          ? "unanchored (kept isracard pending)"
          : "settled (fibi posted)";
      const parts = [
        `fx anchor: ${tx.description}`,
        `${Math.abs(tx.originalAmount).toFixed(2)} ${tx.originalCurrency}`,
        `isracard=₪${ils(actualApi.utils.amountToInteger(tx.chargedAmount))}`,
      ];
      if (res.candidateMinor !== null && res.ratio !== null) {
        parts.push(`fibi=₪${ils(res.candidateMinor)}`);
        parts.push(`ratio=${res.ratio.toFixed(4)}`);
      }
      parts.push(`-> ${state}`);
      logger(parts.join(" "));
    });
    return overrides;
  }

  /** The ILS amount to import (minor units), applying an FX anchor override. */
  private actualAmount(tx: TransactionRow): number {
    return (
      this.fxOverrides.get(tx) ??
      actualApi.utils.amountToInteger(tx.chargedAmount)
    );
  }

  private toIncoming(tx: TransactionRow): IncomingTx {
    const isPending = tx.status === TransactionStatuses.Pending;
    // `isCardKey` decides the MATCH key (unchanged); `isCardCharge` decides
    // charge-date clearing (new, flag-gated).
    const isCardKey = this.isDomesticCardCharge(tx);
    const clearOnChargeDate = Boolean(
      this.config.storage.actual?.clearOnChargeDate,
    );
    const clearOnFibiSettlement = Boolean(
      this.config.storage.actual?.clearOnFibiSettlement,
    );
    const isCardChargeRow = this.isCardCharge(tx);

    // The MATCH key always uses the purchase date so a pending charge and its
    // settled twin share a base key (the settled row may be dated on a later
    // bank charge date — that must not break the collapse). Under either clearing
    // flag the purchase date is formatted TZ-safely; otherwise the upstream UTC
    // formatting is preserved so default behavior is byte-for-byte unchanged.
    const keyDate =
      clearOnChargeDate || clearOnFibiSettlement
        ? toJerusalemDate(tx.date)
        : new Date(tx.date).toISOString().split("T")[0];

    const today = toJerusalemDate(new Date());

    // The card-charge clearing date under the unified `clearOnFibiSettlement` rule:
    // a card charge is CLEARED iff it currently APPEARS ON FIBI — as a settlement
    // OR an auth-hold — otherwise it stays UNCLEARED on the purchase date until it
    // does. There is no per-card-type branch in the "appears on FIBI?" check; the
    // three ways it can appear, in priority order:
    //   1. `tx.bankSettled` — the enrichment matched it to a POSTED FIBI settlement
    //      drill-down. Clear it on the real FIBI charge date (`processedDate`).
    //   2. `fibiDomesticHolds` — FIBI is currently auth-HOLDING this domestic
    //      charge (matched to a "דירקט אושר-ישראכרט" hold by |amount| + date). It
    //      is on FIBI now; clear it. No FIBI charge date exists yet (still an auth,
    //      not a settlement), so clear it on the purchase date.
    //   3. NARROW 0041-only age fallback — a direct-debit (0041) charge posts to
    //      FIBI within ~2-3 days; if both signals above missed it (drill-down out
    //      of window AND the hold already released) and it is >= FIBI_SETTLE_LAG_DAYS
    //      old, it has certainly posted. Gated to 0041 so a monthly-credit (5104)
    //      charge is NEVER aged out ahead of its statement (the reported bug).
    // Anything else stays uncleared. This supersedes clearOnChargeDate's
    // charge-date<=today trigger for CARD charges.
    let cardChargeDate: string | undefined;
    let fibiSettlementPending = false;
    if (clearOnFibiSettlement && isCardChargeRow && !isPending) {
      if (tx.bankSettled) {
        cardChargeDate = toJerusalemDate(tx.processedDate ?? tx.date);
      } else if (this.fibiDomesticHolds.has(tx)) {
        cardChargeDate = keyDate; // on FIBI as a live auth-hold: clear on purchase date
      } else if (
        this.isCard0041(tx) &&
        daysAgo(keyDate, today) >= FIBI_SETTLE_LAG_DAYS
      ) {
        cardChargeDate = keyDate; // 0041-only settle fallback: cleared on the purchase date
      } else {
        fibiSettlementPending = true;
      }
    } else if (clearOnChargeDate && isCardChargeRow && !isPending) {
      // For a COMPLETED card charge under clearOnChargeDate, its effective charge
      // date is processedDate — the real (past) bank charge date when the FIBI
      // enrichment matched it, else still the FUTURE monthly-statement placeholder.
      cardChargeDate = toJerusalemDate(tx.processedDate ?? tx.date);
    }

    // A charge whose effective charge date is still in the future has not been
    // charged yet (FIBI holds it as a pending auth). Importing it cleared on that
    // future date is the premature-clear bug. Treat it as pending: uncleared, on
    // the purchase date — it collapses onto the real settled row later (signature
    // key) and clears on the true FIBI charge date once that date is <= today.
    const chargeInFuture =
      cardChargeDate !== undefined && cardChargeDate > today;

    // FIBI is still HOLDING this FX charge as an auth (a FIBI מטח auth matched in
    // computeFxAnchors, so an override exists). Keep it uncleared at FIBI's hold
    // amount until FIBI posts it (auth gone -> no match next run -> it settles and
    // the kept-pending row collapses onto it via the pend:sig_ key). Same handling
    // as a future-dated charge; the trigger is "FIBI still holds it".
    const fibiHolding = this.fxOverrides.has(tx);

    // Owner's clearing rule (under clearOnFibiSettlement): anything that shows up
    // in FIBI — INCLUDING a FIBI-direct row that is still pending (e.g. a ביטוח
    // credit while it settles) — is CLEARED; only a credit-card expense FIBI has
    // not debited yet stays uncleared. So the pending flag keeps a row uncleared
    // ONLY for card charges; non-card FIBI rows always clear. Other clearing
    // configs keep the original (every-pending-row-uncleared) behavior.
    const pendingKeepsUncleared = clearOnFibiSettlement
      ? isCardChargeRow && isPending
      : isPending;

    const effectivePending =
      pendingKeepsUncleared ||
      chargeInFuture ||
      fibiHolding ||
      fibiSettlementPending;

    // A FIBI-direct NON-CARD row under clearOnFibiSettlement (a ביטוח לאומי /
    // מופ"ת reserve credit, a salary, a standing-order bill...). It clears
    // immediately ("appears on FIBI => cleared"), but its moneyman uniqueId is
    // NOT stable pending->settled: FIBI first shows the credit value-dated
    // ("*יזום", posts next business day) with no reference, then re-reports it
    // settled with a late-assigned identifier and/or a re-stamped date. That
    // changes hash(uniqueId), so its settledImportedId differs between the two
    // views and the settled twin imports as a SECOND row (the recurring
    // duplicate). These rows already carry a stable signature base key
    // (pend:sig_ over |originalAmount|+currency+account); the fix is to ANCHOR
    // their Actual identity to that key by routing them through the planner's
    // base-key (pending) path — cleared, but collapsible pending<->settled — via
    // the decoupled `cleared` flag. Card charges keep their own lifecycle; FX
    // Isracard rows already anchor to the base key through their kept-pending
    // twin, so both are untouched. General rule, not a merchant name-match.
    const anchorToStableKey =
      clearOnFibiSettlement && !isCardChargeRow && !effectivePending;

    // The Actual ROW date. A settled domestic card charge that has actually been
    // charged (charge date <= today) is dated on that real bank charge date so
    // cleared rows reconstruct FIBI's running balance; everything else (pending,
    // a not-yet-charged future card charge, or a still-FIBI-held FX charge) stays
    // on the purchase date.
    const rowDate =
      cardChargeDate !== undefined && !chargeInFuture && !fibiHolding
        ? cardChargeDate
        : keyDate;

    const amount = this.actualAmount(tx);
    const baseKey = isCardKey
      ? computeCardKey({ date: keyDate, amountMinor: amount })
      : computeStableKey({
          originalAmount: tx.originalAmount,
          originalCurrency: tx.originalCurrency,
          account: tx.account,
        });
    return {
      baseKey,
      settledImportedId: this.settledImportedId(tx),
      // Route the FIBI-direct non-card row through the base-key path so its
      // pending and settled views collapse onto ONE row, but keep it cleared.
      isPending: anchorToStableKey ? true : effectivePending,
      cleared: anchorToStableKey,
      amount,
      date: rowDate,
      // Window-match a signature-keyed twin on the purchase/key date, which is
      // stable pending<->settled even when the settled row re-dates to a later
      // bank charge date.
      matchDate: keyDate,
      payeeName: tx.description,
      notes: tx.memo ?? "",
    };
  }

  /**
   * budgetman upsert path (opt-in via `actual.upsert`): match pending->settled on
   * the FX-stable key and update in place instead of duplicating. Pending rows are
   * included only when `keepPending` is also on. Category is never modified.
   */
  private async upsertTransactions(
    txns: Array<TransactionRow>,
    stats: SaveStats,
    onProgress: (status: string) => Promise<void>,
  ) {
    const keepPending = Boolean(this.config.storage.actual?.keepPending);

    const rowsByAccountId = new Map<string, TransactionRow[]>();
    for (const tx of txns) {
      if (tx.status === TransactionStatuses.Pending && !keepPending) continue;
      const actualAccountId = this.bankToActualAccountMap.get(tx.account);
      if (!actualAccountId) {
        stats.otherSkipped++;
        continue;
      }
      const list = rowsByAccountId.get(actualAccountId) ?? [];
      list.push(tx);
      rowsByAccountId.set(actualAccountId, list);
    }

    for (const [actualAccountId, rows] of rowsByAccountId) {
      const accountName =
        this.accountIdToNameMap.get(actualAccountId) || actualAccountId;

      const incoming = rows.map((tx) => this.toIncoming(tx));
      const dates = incoming.map((i) => i.date).sort();
      // Widen the lookup window so a settled charge can still find its earlier
      // pending twin.
      const start = new Date(dates[0]);
      start.setDate(start.getDate() - 7);
      const startDate = start.toISOString().split("T")[0];
      const endDate = new Date().toISOString().split("T")[0];

      const existingRows = await actualApi.getTransactions(
        actualAccountId,
        startDate,
        endDate,
      );
      const existing: ExistingActualTx[] = existingRows.map((e) => ({
        id: e.id,
        imported_id: e.imported_id ?? null,
        amount: e.amount,
        cleared: Boolean(e.cleared),
        notes: e.notes ?? null,
        date: e.date, // for signature-key window matching
        imported_payee: e.imported_payee ?? null, // for placeholder refresh
      }));

      const plan = planActualUpsert(incoming, existing, {
        updateDateOnSettle: Boolean(
          this.config.storage.actual?.clearOnChargeDate ||
          this.config.storage.actual?.clearOnFibiSettlement,
        ),
      });
      logger(
        `[${accountName}] upsert plan: ${plan.adds.length} add, ${plan.updates.length} update`,
      );
      for (const line of plan.report) logger(`[${accountName}] ${line}`);
      await onProgress(`Upserting transactions for account "${accountName}"`);

      if (plan.adds.length > 0) {
        // Use importTransactions for adds so Actual's payee/category rules run.
        const resp = await actualApi
          .importTransactions(
            actualAccountId,
            plan.adds.map((a) => ({ ...a, account: actualAccountId })),
          )
          .catch((error) => {
            logger(`[${accountName}] error adding: ${error.message}`);
            return { errors: [error.message], added: [], updated: [] };
          });
        stats.added += resp.added?.length ?? 0;
      }

      for (const u of plan.updates) {
        // A `payeeName` field is a NAME (placeholder refresh) — resolve it to a
        // payee id, which is what updateTransaction accepts.
        const { payeeName, ...fields } = u.fields;
        const resolved: Record<string, unknown> = { ...fields };
        if (payeeName) resolved.payee = await this.resolvePayeeId(payeeName);
        await actualApi.updateTransaction(u.id, resolved);
      }
      stats.existing += plan.updates.length;
    }

    if (this.config.options.scraping.transactionHashType !== "moneyman") {
      logger("Warning: transactionHashType should be set to 'moneyman'");
    }
  }
}
