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
import { anchorFxAmount, type FibiAuth } from "./fxAnchor.js";

const logger = createLogger("ActualBudgetStorage");

// FIBI posts card settlements within ~2-3 days of the charge. Under
// `clearOnFibiSettlement`, a card charge the enrichment could NOT confirm (no
// drill-down match — e.g. a settlement outside the scrape window) still clears
// once it is at least this many days old, so the unconfirmable tail never sits
// uncleared forever and breaks the reconciliation formula. 5 is a safe margin so
// we never clear ahead of FIBI. `bankSettled` always wins (precise charge date);
// this lag is only a floor.
const FIBI_SETTLE_LAG_DAYS = 5;

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

  constructor(private config: MoneymanConfig) {}

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
    let pool: FibiAuth[] = txns
      .filter((t) => this.isFibiFxAuth(t))
      .map((t) => ({
        amountMinor: actualApi.utils.amountToInteger(t.chargedAmount),
        date: toJerusalemDate(t.date),
      }));
    if (pool.length === 0) return overrides;

    const upsert = Boolean(this.config.storage.actual?.upsert);

    for (const tx of txns) {
      if (tx.companyId !== CompanyTypes.isracard) continue;
      if (!tx.originalCurrency || tx.originalCurrency === "ILS") continue; // FX only
      const isPending = tx.status === TransactionStatuses.Pending;
      if (!isPending && !upsert) continue; // completed FX anchoring needs upsert

      const isracardMinor = actualApi.utils.amountToInteger(tx.chargedAmount);
      const res = anchorFxAmount(
        {
          originalCurrency: tx.originalCurrency,
          chargedAmount: tx.chargedAmount,
          matchDate: toJerusalemDate(tx.date),
        },
        pool,
      );

      const anchored = res.consumedIndex !== null;
      if (anchored) {
        overrides.set(tx, res.amountMinor);
        pool = pool.filter((_, i) => i !== res.consumedIndex);
      }

      // One observability line per FX decision — a running dataset to confirm
      // (or refute) the ~4% FIBI/Isracard FX spread hypothesis, and to show the
      // hold/posted state we acted on.
      const ils = (m: number) => (Math.abs(m) / 100).toFixed(2);
      const state = anchored
        ? "anchored (fibi still holding, kept pending)"
        : isPending
          ? "unanchored (kept isracard pending)"
          : "settled (fibi posted)";
      const parts = [
        `fx anchor: ${tx.description}`,
        `${Math.abs(tx.originalAmount).toFixed(2)} ${tx.originalCurrency}`,
        `isracard=₪${ils(isracardMinor)}`,
      ];
      if (res.candidateMinor !== null && res.ratio !== null) {
        parts.push(`fibi=₪${ils(res.candidateMinor)}`);
        parts.push(`ratio=${res.ratio.toFixed(4)}`);
      }
      parts.push(`-> ${state}`);
      logger(parts.join(" "));
    }
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

    // The card-charge clearing date, and whether FIBI has actually posted it.
    // Under `clearOnFibiSettlement` the authoritative signal is the enrichment
    // MATCH (`tx.bankSettled`): a matched granular is in a POSTED FIBI settlement
    // -> clear it on the FIBI charge date. An unmatched card charge is kept
    // UNCLEARED on the purchase date until FIBI posts it — UNLESS it is already
    // at least FIBI_SETTLE_LAG_DAYS old, in which case FIBI has certainly posted
    // it (the drill-down just didn't confirm it) so we clear it on the purchase
    // date. This supersedes clearOnChargeDate's charge-date<=today trigger for
    // CARD charges.
    let cardChargeDate: string | undefined;
    let fibiSettlementPending = false;
    if (clearOnFibiSettlement && isCardChargeRow && !isPending) {
      if (tx.bankSettled) {
        cardChargeDate = toJerusalemDate(tx.processedDate ?? tx.date);
      } else if (daysAgo(keyDate, today) >= FIBI_SETTLE_LAG_DAYS) {
        cardChargeDate = keyDate; // time-lag fallback: cleared on the purchase date
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

    const effectivePending =
      isPending || chargeInFuture || fibiHolding || fibiSettlementPending;

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
      isPending: effectivePending,
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
        await actualApi.updateTransaction(u.id, u.fields);
      }
      stats.existing += plan.updates.length;
    }

    if (this.config.options.scraping.transactionHashType !== "moneyman") {
      logger("Warning: transactionHashType should be set to 'moneyman'");
    }
  }
}
