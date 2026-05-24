import type { Hex, TransactionReceipt } from "viem";
import { getMarketOnChain, getOperatorTransactionReceipt } from "../chain/index.js";
import { env } from "../config/env.js";
import type { OperatorTransaction } from "../api/operator-transactions.js";
import type { InMemoryStore } from "../api/store.js";
import {
  isRecoverableMatchMetadata,
  recordMatchResult,
  recoverMatchPlan
} from "../trading/index.js";

type RecoveryLogger = {
  info: (message: string, data?: unknown) => void;
};

export type OperatorTransactionRecoveryChain = {
  getTransactionReceipt: typeof getOperatorTransactionReceipt;
  getMarketOnChain: typeof getMarketOnChain;
};

const defaultRecoveryChain: OperatorTransactionRecoveryChain = {
  getTransactionReceipt: getOperatorTransactionReceipt,
  getMarketOnChain
};

export type OperatorTransactionRecoveryWorkerOptions = {
  store: InMemoryStore;
  intervalSeconds?: number | undefined;
  limit?: number | undefined;
  chain?: OperatorTransactionRecoveryChain | undefined;
  logger?: RecoveryLogger | undefined;
};

export type OperatorTransactionRecoveryRunSummary = {
  checked: number;
  confirmed: number;
  failed: number;
  pending: number;
  reconciledMarkets: number;
  reconciledResolutions: number;
  recoveredMatches: number;
  recoveredTrades: RecoveredMatchTrade[];
  errors: string[];
};

export type RecoveredMatchTrade = {
  operatorTransactionId: string;
  tradeId: string;
  txHash: Hex;
  orders: {
    id: string;
    status: string;
    remainingMaker: string;
  }[];
};

export class OperatorTransactionRecoveryWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastRunStartedAt: string | undefined;
  private lastRunCompletedAt: string | undefined;
  private lastRun: OperatorTransactionRecoveryRunSummary | undefined;
  private readonly chain: OperatorTransactionRecoveryChain;
  readonly intervalSeconds: number;
  readonly limit: number;

  constructor(private readonly options: OperatorTransactionRecoveryWorkerOptions) {
    this.intervalSeconds = options.intervalSeconds ?? env.OPERATOR_TX_RECOVERY_POLL_INTERVAL_SECONDS;
    this.limit = options.limit ?? env.OPERATOR_TX_RECOVERY_LIMIT;
    this.chain = options.chain ?? defaultRecoveryChain;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalSeconds * 1000);
    this.timer.unref();
    void this.runOnce();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  status() {
    return {
      enabled: Boolean(this.timer),
      running: this.running,
      intervalSeconds: this.intervalSeconds,
      limit: this.limit,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunCompletedAt: this.lastRunCompletedAt,
      lastRun: this.lastRun
    };
  }

  async runOnce(): Promise<OperatorTransactionRecoveryRunSummary> {
    if (this.running) return emptyRun(["Operator transaction recovery worker is already running"]);
    this.running = true;
    this.lastRunStartedAt = new Date().toISOString();
    const summary = emptyRun([]);

    try {
      const pending = this.options.store
        .listOperatorTransactions({ status: "pending", limit: this.limit })
        .filter(hasHash);

      for (const transaction of pending) {
        await this.recoverTransaction(transaction, summary);
      }
      for (const transaction of this.confirmedMatchesMissingTrades()) {
        await this.reconcileMatch(transaction, summary);
      }
    } finally {
      this.running = false;
      this.lastRunCompletedAt = new Date().toISOString();
      this.lastRun = summary;
      this.options.logger?.info("Operator transaction recovery completed run", summary);
    }

    return summary;
  }

  private async recoverTransaction(
    transaction: OperatorTransaction & { txHash: Hex },
    summary: OperatorTransactionRecoveryRunSummary
  ): Promise<void> {
    summary.checked += 1;
    try {
      const receipt = await this.chain.getTransactionReceipt(transaction.txHash);
      if (!receipt) {
        summary.pending += 1;
        return;
      }
      if (receipt.status !== "success") {
        this.options.store.upsertOperatorTransaction({
          ...transaction,
          status: "failed",
          error: `Transaction reverted: ${transaction.txHash}`,
          failedAt: new Date().toISOString()
        });
        summary.failed += 1;
        return;
      }

      this.options.store.upsertOperatorTransaction({
        ...transaction,
        status: "confirmed",
        confirmedAt: new Date().toISOString()
      });
      summary.confirmed += 1;
      await this.reconcile(transaction, receipt, summary);
    } catch (error) {
      summary.errors.push(`${transaction.id}: ${errorMessage(error)}`);
    }
  }

  private async reconcile(
    transaction: OperatorTransaction & { txHash: Hex },
    _receipt: TransactionReceipt,
    summary: OperatorTransactionRecoveryRunSummary
  ): Promise<void> {
    if (transaction.action === "SUBMIT_RESOLUTION") {
      const resolution = this.options.store.getResolution(transaction.entityId);
      if (resolution && resolution.status !== "submitted") {
        this.options.store.upsertResolution({ ...resolution, status: "submitted" });
        summary.reconciledResolutions += 1;
      }
      return;
    }

    if (transaction.action === "CREATE_MARKET") {
      const market = this.options.store.getMarket(transaction.entityId);
      if (!market || market.conditionId) return;
      const stored = await this.chain.getMarketOnChain(market.id);
      if (!stored) return;
      this.options.store.updateMarket({ ...market, conditionId: stored.conditionId });
      summary.reconciledMarkets += 1;
      return;
    }

    if (transaction.action === "MATCH_ORDERS") {
      await this.reconcileMatch(transaction, summary);
    }
  }

  private confirmedMatchesMissingTrades(): (OperatorTransaction & { txHash: Hex })[] {
    return this.options.store
      .listOperatorTransactions({ status: "confirmed", action: "MATCH_ORDERS", limit: this.limit })
      .filter(hasHash)
      .filter((transaction) => !this.options.store.getClobTradeByTransactionHash(transaction.txHash));
  }

  private async reconcileMatch(
    transaction: OperatorTransaction & { txHash: Hex },
    summary: OperatorTransactionRecoveryRunSummary
  ): Promise<void> {
    const existing = this.options.store.getClobTradeByTransactionHash(transaction.txHash);
    if (existing) {
      if (hasRecoveredMatchResult(transaction.result)) return;
      this.storeRecoveredMatchResult(transaction, {
        operatorTransactionId: transaction.id,
        tradeId: existing.id,
        txHash: transaction.txHash,
        orders: this.currentMatchOrderStates(transaction.metadata)
      });
      return;
    }

    if (!isRecoverableMatchMetadata(transaction.metadata)) {
      summary.errors.push(`${transaction.id}: recoverable match metadata is missing`);
      return;
    }

    const result = recordMatchResult(
      this.options.store,
      recoverMatchPlan(this.options.store, transaction.metadata),
      transaction.txHash
    );
    const recovered = {
      operatorTransactionId: transaction.id,
      tradeId: result.trade.id,
      txHash: transaction.txHash,
      orders: result.orders.map((order) => ({
        id: order.id,
        status: order.status,
        remainingMaker: order.remainingMaker
      }))
    };
    this.storeRecoveredMatchResult(transaction, recovered);
    summary.recoveredMatches += 1;
    summary.recoveredTrades.push(recovered);
  }

  private storeRecoveredMatchResult(
    transaction: OperatorTransaction,
    recovered: RecoveredMatchTrade
  ): void {
    this.options.store.upsertOperatorTransaction({
      ...transaction,
      result: {
        recoveredMatch: recovered
      }
    });
  }

  private currentMatchOrderStates(metadata: unknown): RecoveredMatchTrade["orders"] {
    if (!isRecoverableMatchMetadata(metadata)) return [];
    return [metadata.takerOrderId, ...metadata.makerOrderIds]
      .map((id) => this.options.store.getClobOrder(id))
      .filter((order): order is NonNullable<typeof order> => Boolean(order))
      .map((order) => ({
        id: order.id,
        status: order.status,
        remainingMaker: order.remainingMaker
      }));
  }
}

export function createOperatorTransactionRecoveryWorker(options: OperatorTransactionRecoveryWorkerOptions) {
  return new OperatorTransactionRecoveryWorker(options);
}

function emptyRun(errors: string[]): OperatorTransactionRecoveryRunSummary {
  return {
    checked: 0,
    confirmed: 0,
    failed: 0,
    pending: 0,
    reconciledMarkets: 0,
    reconciledResolutions: 0,
    recoveredMatches: 0,
    recoveredTrades: [],
    errors
  };
}

function hasHash(transaction: OperatorTransaction): transaction is OperatorTransaction & { txHash: Hex } {
  return Boolean(transaction.txHash);
}

function hasRecoveredMatchResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return "recoveredMatch" in result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
