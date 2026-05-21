import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { matchExchangeOrders } from "../chain/index.js";
import type { InMemoryStore } from "../api/store.js";
import { env } from "../config/env.js";
import { proportionalTakingAmount } from "./orderbook.js";
import type { StoredClobFill, StoredClobOrder, StoredClobTrade } from "./types.js";

export type MatchPlan = {
  takerOrder: StoredClobOrder;
  makerOrders: StoredClobOrder[];
  takerFillAmount: string;
  makerFillAmounts: string[];
  shareSize: string;
};

export type MatchResult = {
  trade: StoredClobTrade;
  fills: StoredClobFill[];
  orders: StoredClobOrder[];
};

export type AutoMatchSummary = {
  attempted: boolean;
  matched: boolean;
  reason?: string | undefined;
  result?: MatchResult | undefined;
};

export function planComplementaryMatch(
  takerOrder: StoredClobOrder,
  openOrders: StoredClobOrder[],
  maxMakers = env.CLOB_AUTO_MATCH_MAX_MAKERS
): MatchPlan | undefined {
  if (!isOpenOrder(takerOrder)) return undefined;

  const candidates = openOrders
    .filter((order) => isComplementaryCandidate(takerOrder, order))
    .filter((order) => isCrossingBuySell(takerOrder, order))
    .sort((left, right) => compareMakerPriority(takerOrder, left, right));
  const takerCapacity = orderShareCapacity(takerOrder);
  if (takerCapacity <= 0n) return undefined;

  let remainingShares = takerCapacity;
  let shareSize = 0n;
  const makerOrders: StoredClobOrder[] = [];
  const makerFillAmounts: string[] = [];

  for (const makerOrder of candidates) {
    if (makerOrders.length >= maxMakers || remainingShares <= 0n) break;

    const candidateShares = min(remainingShares, orderShareCapacity(makerOrder));
    const makerFillAmount = makerAmountForShares(makerOrder, candidateShares);
    if (candidateShares <= 0n || makerFillAmount <= 0n) continue;

    makerOrders.push(makerOrder);
    makerFillAmounts.push(makerFillAmount.toString());
    remainingShares -= candidateShares;
    shareSize += candidateShares;
  }

  if (makerOrders.length === 0 || shareSize <= 0n) return undefined;

  const takerFillAmount = makerAmountForShares(takerOrder, shareSize);
  if (takerFillAmount <= 0n) return undefined;

  return {
    takerOrder,
    makerOrders,
    takerFillAmount: takerFillAmount.toString(),
    makerFillAmounts,
    shareSize: shareSize.toString()
  };
}

export async function autoMatchOrder(store: InMemoryStore, takerOrder: StoredClobOrder): Promise<AutoMatchSummary> {
  if (!env.CLOB_AUTO_MATCH_ENABLED) {
    return { attempted: false, matched: false, reason: "Automatic CLOB matching is disabled" };
  }

  const plan = planComplementaryMatch(takerOrder, store.listClobOrders(takerOrder.marketId));
  if (!plan) return { attempted: true, matched: false, reason: "No crossing BUY/SELL orders found" };

  return {
    attempted: true,
    matched: true,
    result: await executeMatchPlan(store, plan)
  };
}

export async function tickAutoMatcher(
  store: InMemoryStore,
  input: { marketId?: string | undefined; limit: number }
): Promise<AutoMatchSummary[]> {
  const orders = store
    .listClobOrders(input.marketId)
    .filter(isOpenOrder)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(0, input.limit);

  const summaries: AutoMatchSummary[] = [];
  for (const order of orders) {
    if (!isOpenOrder(store.getClobOrder(order.id) ?? order)) continue;
    try {
      summaries.push(await autoMatchOrder(store, store.getClobOrder(order.id) ?? order));
    } catch (error) {
      summaries.push({
        attempted: true,
        matched: false,
        reason: error instanceof Error ? error.message : "Automatic matching failed"
      });
    }
  }

  return summaries;
}

export async function executeMatchPlan(store: InMemoryStore, plan: MatchPlan): Promise<MatchResult> {
  const transactionHash = await matchExchangeOrders({
    takerOrder: plan.takerOrder,
    makerOrders: plan.makerOrders,
    takerFillAmount: plan.takerFillAmount,
    makerFillAmounts: plan.makerFillAmounts
  });
  return recordSuccessfulMatch(store, plan, transactionHash);
}

export function manualMatchPlan(input: {
  takerOrder: StoredClobOrder;
  makerOrders: StoredClobOrder[];
  takerFillAmount: string;
  makerFillAmounts: string[];
}): MatchPlan {
  return {
    ...input,
    shareSize: executedShareSize(input.takerOrder, input.takerFillAmount).toString()
  };
}

export function matchRequestError(plan: MatchPlan): string | undefined {
  if (!isOpenOrder(plan.takerOrder)) return "Taker order is not open";
  if (BigInt(plan.takerFillAmount) > BigInt(plan.takerOrder.remainingMaker)) return "Taker fill exceeds remaining order size";

  for (const [index, order] of plan.makerOrders.entries()) {
    if (order.marketId !== plan.takerOrder.marketId) return "All matched orders must belong to the same market";
    if (!isOpenOrder(order)) return `Maker order ${order.id} is not open`;
    if (BigInt(plan.makerFillAmounts[index] ?? "0") > BigInt(order.remainingMaker)) {
      return `Maker fill exceeds remaining order size for ${order.id}`;
    }
  }

  return undefined;
}

export function isOpenOrder(order: StoredClobOrder): boolean {
  return order.status === "open" || order.status === "partially_filled";
}

function recordSuccessfulMatch(store: InMemoryStore, plan: MatchPlan, transactionHash: Hex): MatchResult {
  const createdAt = new Date().toISOString();
  const tradeId = randomUUID();
  const filledOrders = [
    applyMakerFill(plan.takerOrder, plan.takerFillAmount, createdAt),
    ...plan.makerOrders.map((order, index) => applyMakerFill(order, plan.makerFillAmounts[index] ?? "0", createdAt))
  ];
  const fills: StoredClobFill[] = [
    createFill(tradeId, plan.takerOrder, plan.takerFillAmount, transactionHash, createdAt),
    ...plan.makerOrders.map((order, index) =>
      createFill(tradeId, order, plan.makerFillAmounts[index] ?? "0", transactionHash, createdAt)
    )
  ];
  const trade = store.recordClobTrade(
    {
      id: tradeId,
      marketId: plan.takerOrder.marketId,
      takerOrderId: plan.takerOrder.id,
      makerOrderIds: plan.makerOrders.map((order) => order.id),
      transactionHash,
      takerFillAmount: plan.takerFillAmount,
      makerFillAmounts: plan.makerFillAmounts,
      createdAt
    },
    fills,
    filledOrders
  );

  return { trade, fills, orders: filledOrders };
}

function isComplementaryCandidate(takerOrder: StoredClobOrder, makerOrder: StoredClobOrder): boolean {
  return makerOrder.id !== takerOrder.id
    && makerOrder.marketId === takerOrder.marketId
    && makerOrder.outcomeSide === takerOrder.outcomeSide
    && makerOrder.side !== takerOrder.side
    && isOpenOrder(makerOrder);
}

function isCrossingBuySell(first: StoredClobOrder, second: StoredClobOrder): boolean {
  const buy = first.side === "BUY" ? first : second;
  const sell = first.side === "SELL" ? first : second;
  return priceNumerator(buy) * priceDenominator(sell) >= priceNumerator(sell) * priceDenominator(buy);
}

function compareMakerPriority(takerOrder: StoredClobOrder, left: StoredClobOrder, right: StoredClobOrder): number {
  const byPrice = takerOrder.side === "BUY"
    ? comparePrice(left, right)
    : comparePrice(right, left);
  if (byPrice !== 0) return byPrice;
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function comparePrice(left: StoredClobOrder, right: StoredClobOrder): number {
  const comparison = priceNumerator(left) * priceDenominator(right) - priceNumerator(right) * priceDenominator(left);
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

function priceNumerator(order: StoredClobOrder): bigint {
  return order.side === "BUY" ? BigInt(order.order.makerAmount) : BigInt(order.order.takerAmount);
}

function priceDenominator(order: StoredClobOrder): bigint {
  return order.side === "BUY" ? BigInt(order.order.takerAmount) : BigInt(order.order.makerAmount);
}

function orderShareCapacity(order: StoredClobOrder): bigint {
  if (order.side === "SELL") return BigInt(order.remainingMaker);
  return executedShareSize(order, order.remainingMaker);
}

function makerAmountForShares(order: StoredClobOrder, shares: bigint): bigint {
  if (order.side === "SELL") return min(shares, BigInt(order.remainingMaker));

  const making = (shares * BigInt(order.order.makerAmount)) / BigInt(order.order.takerAmount);
  return min(making, BigInt(order.remainingMaker));
}

function executedShareSize(order: StoredClobOrder, makerFillAmount: string): bigint {
  if (order.side === "SELL") return BigInt(makerFillAmount);
  return BigInt(proportionalTakingAmount(order, makerFillAmount));
}

function applyMakerFill(order: StoredClobOrder, makingAmount: string, updatedAt: string): StoredClobOrder {
  const remaining = BigInt(order.remainingMaker) - BigInt(makingAmount);
  return {
    ...order,
    remainingMaker: remaining.toString(),
    status: remaining === 0n ? "filled" : "partially_filled",
    updatedAt
  };
}

function createFill(
  tradeId: string,
  order: StoredClobOrder,
  makerAmountFilled: string,
  transactionHash: Hex,
  createdAt: string
): StoredClobFill {
  return {
    id: randomUUID(),
    tradeId,
    orderId: order.id,
    makerAmountFilled,
    takerAmountFilled: proportionalTakingAmount(order, makerAmountFilled),
    transactionHash,
    createdAt
  };
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
