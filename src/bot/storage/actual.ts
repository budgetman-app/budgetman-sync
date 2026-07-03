import * as actualApi from "@actual-app/api";
import type { ImportTransactionEntity } from "@actual-app/core/@types/src/types/models/index.js";
import { hash } from "hash-it";
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
  computeStableKey,
  planActualUpsert,
  type ExistingActualTx,
  type IncomingTx,
} from "./actualUpsert.js";

const logger = createLogger("ActualBudgetStorage");

export class ActualBudgetStorage implements TransactionStorage {
  private bankToActualAccountMap = new Map<string, string>();
  private accountIdToNameMap = new Map<string, string>();

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
      if (this.config.storage.actual?.upsert) {
        await this.upsertTransactions(txns, stats, onProgress);
        return stats;
      }

      const keepPending = Boolean(this.config.storage.actual?.keepPending);
      const transactionsByActualAccountId = new Map<
        string,
        ImportTransactionEntity[]
      >();

      for (let tx of txns) {
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

  private convertTransactionToActualFormat(
    tx: TransactionRow,
    actualAccountId: string,
  ): ImportTransactionEntity {
    const amount = actualApi.utils.amountToInteger(tx.chargedAmount);

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

  private toIncoming(tx: TransactionRow): IncomingTx {
    return {
      baseKey: computeStableKey({
        date: new Date(tx.date).toISOString().split("T")[0],
        originalAmount: tx.originalAmount,
        originalCurrency: tx.originalCurrency,
        description: tx.description,
        account: tx.account,
      }),
      settledImportedId: this.settledImportedId(tx),
      isPending: tx.status === TransactionStatuses.Pending,
      amount: actualApi.utils.amountToInteger(tx.chargedAmount),
      date: new Date(tx.date).toISOString().split("T")[0],
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
      }));

      const plan = planActualUpsert(incoming, existing);
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
