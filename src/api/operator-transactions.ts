import type { Hex } from "viem";
import { randomUUID } from "node:crypto";
import type { InMemoryStore } from "./store.js";

export type OperatorTransactionAction =
  | "CREATE_MARKET"
  | "MATCH_ORDERS"
  | "SUBMIT_RESOLUTION";

export type OperatorTransactionStatus =
  | "attempted"
  | "pending"
  | "confirmed"
  | "failed";

export type OperatorTransactionRetryPolicy = {
  disposition:
    | "wait_for_recovery"
    | "manual_resolution_retry"
    | "fresh_submit_allowed"
    | "terminal";
  retryable: boolean;
  reason: string;
};

export type OperatorTransaction = {
  id: string;
  action: OperatorTransactionAction;
  entityId: string;
  status: OperatorTransactionStatus;
  txHash?: Hex | undefined;
  metadata?: unknown;
  result?: unknown;
  error?: string | undefined;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string | undefined;
  confirmedAt?: string | undefined;
  failedAt?: string | undefined;
};

export type OperatorTransactionInput = Omit<
  OperatorTransaction,
  "createdAt" | "updatedAt"
> & {
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export async function runTrackedOperatorTransaction<T>(
  store: InMemoryStore,
  input: {
    action: OperatorTransactionAction;
    entityId: string;
    metadata?: unknown;
    execute: (onSubmitted: (hash: Hex) => void) => Promise<T>;
  }
): Promise<T> {
  const active = store.getActiveOperatorTransaction(input.action, input.entityId);
  if (active) {
    throw new Error(`Operator transaction already ${active.status}: ${input.action} ${input.entityId}`);
  }

  const id = randomUUID();
  const transaction = store.upsertOperatorTransaction({
    id,
    action: input.action,
    entityId: input.entityId,
    status: "attempted",
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
  });

  try {
    const result = await input.execute((txHash) => {
      store.upsertOperatorTransaction({
        ...transaction,
        status: "pending",
        txHash,
        submittedAt: new Date().toISOString()
      });
    });
    const pending = store.getOperatorTransaction(id) ?? transaction;
    store.upsertOperatorTransaction({
      ...pending,
      status: "confirmed",
      confirmedAt: new Date().toISOString()
    });
    return result;
  } catch (error) {
    const pending = store.getOperatorTransaction(id) ?? transaction;
    if (pending.status === "pending" && pending.txHash) {
      store.upsertOperatorTransaction({
        ...pending,
        error: errorMessage(error)
      });
      throw error;
    }

    store.upsertOperatorTransaction({
      ...pending,
      status: "failed",
      error: errorMessage(error),
      failedAt: new Date().toISOString()
    });
    throw error;
  }
}

export function operatorTransactionRetryPolicy(
  transaction: OperatorTransaction
): OperatorTransactionRetryPolicy {
  if (transaction.status === "attempted" || transaction.status === "pending") {
    return {
      disposition: "wait_for_recovery",
      retryable: false,
      reason: "The operator action is still active or has a broadcast transaction to recover"
    };
  }

  if (transaction.status === "confirmed") {
    return {
      disposition: "terminal",
      retryable: false,
      reason: "Confirmed operator actions are not retried"
    };
  }

  if (transaction.txHash) {
    return {
      disposition: "terminal",
      retryable: false,
      reason: "Failed broadcast transactions are inspected by tx hash and are not blindly resubmitted"
    };
  }

  if (transaction.action === "SUBMIT_RESOLUTION") {
    return {
      disposition: "manual_resolution_retry",
      retryable: true,
      reason: "Resolution submission failed before a tx hash was recorded and requires an operator retry"
    };
  }

  return {
    disposition: "fresh_submit_allowed",
    retryable: true,
    reason: "The action failed before a tx hash was recorded; the normal submit path may create a fresh attempt"
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
