import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { prepareExchangeOrder, validateExchangeOrder } from "../chain/index.js";
import type { InMemoryStore } from "../api/store.js";
import { env } from "../config/env.js";
import type { OutcomeSide } from "../markets/types.js";
import type { StoredClobOrder } from "./types.js";
import type { AutoMatchSummary, MatchPlan } from "./matcher.js";
import { executeMatchPlan, isOpenOrder } from "./matcher.js";

export async function fillWithHouseLiquidity(
  store: InMemoryStore,
  takerOrder: StoredClobOrder
): Promise<AutoMatchSummary> {
  if (!env.HOUSE_LIQUIDITY_ENABLED) {
    return { attempted: false, matched: false, reason: "House liquidity is disabled" };
  }
  if (!isOpenOrder(takerOrder)) {
    return { attempted: false, matched: false, reason: "Taker order is not open" };
  }
  if (takerOrder.side !== "BUY") {
    return { attempted: true, matched: false, reason: "House liquidity currently supports BUY orders only" };
  }
  if (isHouseWallet(takerOrder.order.maker)) {
    return { attempted: true, matched: false, reason: "House liquidity skipped because the taker is the house wallet" };
  }

  const market = store.getMarket(takerOrder.marketId);
  if (!market || market.status !== "open" || market.tradingStatus !== "open") {
    return { attempted: false, matched: false, reason: "Market is not open for trading" };
  }

  const houseOrder = await createHouseComplementBuyOrder(takerOrder);
  store.upsertClobOrder(houseOrder);

  const plan: MatchPlan = {
    takerOrder,
    makerOrders: [houseOrder],
    takerFillAmount: takerOrder.remainingMaker,
    makerFillAmounts: [houseOrder.remainingMaker],
    shareSize: takerOrder.order.takerAmount
  };

  try {
    return {
      attempted: true,
      matched: true,
      result: await executeMatchPlan(store, plan)
    };
  } catch (error) {
    store.upsertClobOrder({
      ...houseOrder,
      status: "cancelled",
      updatedAt: new Date().toISOString()
    });
    return {
      attempted: true,
      matched: false,
      reason: error instanceof Error ? error.message : "House liquidity match failed"
    };
  }
}

export async function tickHouseLiquidity(
  store: InMemoryStore,
  input: { marketId?: string | undefined; limit: number }
): Promise<AutoMatchSummary[]> {
  const orders = store
    .listClobOrders(input.marketId)
    .filter((order) => isOpenOrder(order) && order.side === "BUY")
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(0, input.limit);

  const summaries: AutoMatchSummary[] = [];
  for (const order of orders) {
    const current = store.getClobOrder(order.id) ?? order;
    if (!isOpenOrder(current)) continue;
    summaries.push(await fillWithHouseLiquidity(store, current));
  }

  return summaries;
}

async function createHouseComplementBuyOrder(takerOrder: StoredClobOrder): Promise<StoredClobOrder> {
  const account = privateKeyToAccount(housePrivateKey());
  const takerCollateral = BigInt(takerOrder.order.makerAmount);
  const shareAmount = BigInt(takerOrder.order.takerAmount);
  const houseCollateral = shareAmount - takerCollateral;
  if (houseCollateral <= 0n) {
    throw new Error("House liquidity cannot quote non-positive complementary collateral");
  }
  if (takerCollateral > maxHouseOrderAmount()) {
    throw new Error("Order exceeds house liquidity max order size");
  }

  const prepared = await prepareExchangeOrder({
    marketId: takerOrder.marketId,
    outcomeSide: complementOutcome(takerOrder.outcomeSide),
    maker: account.address,
    side: "BUY",
    makerAmount: houseCollateral.toString(),
    takerAmount: shareAmount.toString()
  });

  const signature = await account.signTypedData({
    domain: prepared.typedData.domain,
    types: prepared.typedData.types,
    primaryType: "Order",
    message: orderMessageForSigning(prepared.order)
  });

  const order = {
    ...prepared.order,
    signature
  };
  const orderHash = await validateExchangeOrder(order);
  const now = new Date().toISOString();

  return {
    id: `house-${randomUUID()}`,
    orderHash,
    marketId: takerOrder.marketId,
    outcomeSide: complementOutcome(takerOrder.outcomeSide),
    order,
    side: "BUY",
    remainingMaker: order.makerAmount,
    status: "open",
    createdAt: now,
    updatedAt: now
  };
}

function housePrivateKey(): Hex {
  const key = env.HOUSE_LIQUIDITY_PRIVATE_KEY || env.PRIVATE_KEY;
  if (!key) throw new Error("HOUSE_LIQUIDITY_PRIVATE_KEY or PRIVATE_KEY is required for house liquidity");
  return key as Hex;
}

function isHouseWallet(address: string): boolean {
  return privateKeyToAccount(housePrivateKey()).address.toLowerCase() === address.toLowerCase();
}

function maxHouseOrderAmount(): bigint {
  return BigInt(Math.floor(env.HOUSE_LIQUIDITY_MAX_ORDER_USDC * 1_000_000));
}

function complementOutcome(outcome: OutcomeSide): OutcomeSide {
  if (outcome === "YES") return "NO";
  if (outcome === "NO") return "YES";
  if (outcome === "OVER") return "UNDER";
  return "OVER";
}

function orderMessageForSigning(order: StoredClobOrder["order"]) {
  return {
    salt: BigInt(order.salt),
    maker: order.maker,
    signer: order.signer,
    taker: order.taker,
    tokenId: BigInt(order.tokenId),
    makerAmount: BigInt(order.makerAmount),
    takerAmount: BigInt(order.takerAmount),
    expiration: BigInt(order.expiration),
    nonce: BigInt(order.nonce),
    feeRateBps: BigInt(order.feeRateBps),
    side: order.side,
    signatureType: order.signatureType
  };
}
