import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { InMemoryStore } from "../src/api/store.js";
import { registerRoutes, type ClobRouteChain } from "../src/api/routes.js";
import { erc1155ConditionalTokensAbi, erc20CollateralAbi } from "../src/chain/abis.js";
import {
  buildBuyOrderReadiness,
  buildSellOrderReadiness,
  type ExchangeOrderReadiness
} from "../src/chain/exchange.js";
import { createYesNoMarket } from "../src/markets/definitions.js";
import { SourceRegistry } from "../src/sources/index.js";
import { buildOrderbook } from "../src/trading/orderbook.js";
import { manualMatchPlan, planComplementaryMatch, recordMatchResult } from "../src/trading/matcher.js";
import type { ExchangeOrder, StoredClobOrder } from "../src/trading/types.js";

const maker = "0x1111111111111111111111111111111111111111" as Address;
const makerTwo = "0x2222222222222222222222222222222222222222" as Address;
const exchange = "0x3333333333333333333333333333333333333333" as Address;
const collateral = "0x4444444444444444444444444444444444444444" as Address;
const ctf = "0x5555555555555555555555555555555555555555" as Address;
const transactionHash = `0x${"a".repeat(64)}` as Hex;

test("BUY readiness checks collateral balance and approval transaction payload", () => {
  const readiness = buildBuyOrderReadiness({
    marketId: "market-1",
    outcomeSide: "YES",
    maker,
    tokenId: "20",
    exchange,
    collateral,
    requiredAmount: "100",
    balance: "120",
    allowance: "0"
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.asset.kind, "COLLATERAL");
  assert.equal(readiness.asset.hasBalance, true);
  assert.equal(readiness.approval.approved, false);
  assert.ok(readiness.approval.transaction);

  const decoded = decodeFunctionData({
    abi: erc20CollateralAbi,
    data: readiness.approval.transaction.data
  });
  assert.equal(decoded.functionName, "approve");
  assert.equal(decoded.args[0], exchange);
});

test("SELL readiness checks Conditional Tokens approval payload", () => {
  const readiness = buildSellOrderReadiness({
    marketId: "market-1",
    outcomeSide: "YES",
    maker,
    tokenId: "20",
    exchange,
    conditionalTokens: ctf,
    requiredAmount: "100",
    balance: "50",
    approved: false
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.asset.kind, "CONDITIONAL_TOKEN");
  assert.equal(readiness.asset.hasBalance, false);
  assert.ok(readiness.approval.transaction);

  const decoded = decodeFunctionData({
    abi: erc1155ConditionalTokensAbi,
    data: readiness.approval.transaction.data
  });
  assert.equal(decoded.functionName, "setApprovalForAll");
  assert.deepEqual(decoded.args, [exchange, true]);
});

test("signed order submission rejects missing balance or approval before signature validation", async () => {
  const store = marketStore();
  let validateCalled = false;
  const app = await testApp(store, {
    getMarketOnChain: async () => storedMarket(),
    getExchangeOrderReadiness: async () => unreadyBuyReadiness(),
    validateExchangeOrder: async () => {
      validateCalled = true;
      return `0x${"b".repeat(64)}` as Hex;
    },
    getAccountPortfolioBalances: async () => portfolioBalances()
  });
  const response = await app.inject({
    method: "POST",
    url: "/clob/orders",
    payload: {
      marketId: "market-1",
      outcomeSide: "YES",
      order: exchangeOrder({ tokenId: "20", side: 0, makerAmount: "100", takerAmount: "200" })
    }
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "Order maker balance or exchange approval is not ready");
  assert.equal(validateCalled, false);
  await app.close();
});

test("orderbook aggregates open levels and excludes filled orders", () => {
  const bids = [
    storedOrder({ id: "bid-a", side: "BUY", makerAmount: "50", takerAmount: "100", remainingMaker: "50" }),
    storedOrder({ id: "bid-b", side: "BUY", makerAmount: "25", takerAmount: "50", remainingMaker: "25" }),
    storedOrder({ id: "bid-filled", side: "BUY", makerAmount: "10", takerAmount: "20", remainingMaker: "0", status: "filled" })
  ];
  const ask = storedOrder({ id: "ask", side: "SELL", makerAmount: "80", takerAmount: "48", remainingMaker: "40" });
  const book = buildOrderbook([...bids, ask]) as Record<string, {
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
    bestBid?: string;
    bestAsk?: string;
  }>;

  assert.deepEqual(book.YES.bids, [{ price: "0.5", size: "150" }]);
  assert.deepEqual(book.YES.asks, [{ price: "0.6", size: "40" }]);
  assert.equal(book.YES.bestBid, "0.5");
  assert.equal(book.YES.bestAsk, "0.6");
});

test("matcher selects best price then order time", () => {
  const taker = storedOrder({
    id: "buy",
    side: "BUY",
    makerAmount: "60",
    takerAmount: "100",
    remainingMaker: "60",
    createdAt: "2026-05-21T00:00:05.000Z"
  });
  const cheaper = storedOrder({
    id: "cheap",
    side: "SELL",
    makerAmount: "30",
    takerAmount: "12",
    remainingMaker: "30",
    createdAt: "2026-05-21T00:00:04.000Z"
  });
  const earlierSamePrice = storedOrder({
    id: "same-early",
    side: "SELL",
    makerAmount: "30",
    takerAmount: "15",
    remainingMaker: "30",
    createdAt: "2026-05-21T00:00:01.000Z"
  });
  const laterSamePrice = storedOrder({
    id: "same-late",
    side: "SELL",
    makerAmount: "30",
    takerAmount: "15",
    remainingMaker: "30",
    createdAt: "2026-05-21T00:00:02.000Z"
  });

  const plan = planComplementaryMatch(taker, [laterSamePrice, cheaper, earlierSamePrice, taker]);
  assert.deepEqual(plan?.makerOrders.map((order) => order.id), ["cheap", "same-early", "same-late"]);
});

test("fill bookkeeping records trades and partial or full order remaining sizes", () => {
  const store = new InMemoryStore();
  const taker = storedOrder({ id: "buy", side: "BUY", makerAmount: "60", takerAmount: "100", remainingMaker: "60" });
  const makerSell = storedOrder({
    id: "sell",
    side: "SELL",
    makerAmount: "40",
    takerAmount: "24",
    remainingMaker: "40",
    maker: makerTwo
  });
  store.upsertClobOrder(taker);
  store.upsertClobOrder(makerSell);

  const plan = manualMatchPlan({
    takerOrder: taker,
    makerOrders: [makerSell],
    takerFillAmount: "24",
    makerFillAmounts: ["40"]
  });
  const result = recordMatchResult(store, plan, transactionHash);

  assert.equal(result.trade.takerFillAmount, "24");
  assert.equal(store.getClobOrder("buy")?.status, "partially_filled");
  assert.equal(store.getClobOrder("buy")?.remainingMaker, "36");
  assert.equal(store.getClobOrder("sell")?.status, "filled");
  assert.equal(store.getClobOrder("sell")?.remainingMaker, "0");
  assert.equal(store.listClobTrades("market-1").length, 1);
  assert.equal(store.listClobFills().length, 2);
});

test("matcher and operator endpoints are protected", async () => {
  const app = await testApp(marketStore(), {
    getMarketOnChain: async () => storedMarket(),
    getExchangeOrderReadiness: async () => unreadyBuyReadiness(),
    validateExchangeOrder: async () => `0x${"c".repeat(64)}` as Hex,
    getAccountPortfolioBalances: async () => portfolioBalances()
  });

  const match = await app.inject({ method: "POST", url: "/clob/matches", payload: {} });
  const tick = await app.inject({ method: "POST", url: "/clob/matcher/tick", payload: {} });

  assert.ok([401, 503].includes(match.statusCode));
  assert.ok([401, 503].includes(tick.statusCode));
  await app.close();
});

test("portfolio summarizes orders, fills, balances, and redeemable submitted positions", async () => {
  const store = marketStore();
  const market = store.getMarket("market-1");
  assert.ok(market);
  store.upsertMarket({ ...market, conditionId: storedMarket().conditionId });
  store.upsertResolution({
    marketId: "market-1",
    marketType: "YES_NO",
    outcome: "YES",
    payoutVector: [0, 1],
    status: "submitted",
    source: { provider: "test" },
    observedAt: "2026-05-21T00:00:00.000Z",
    computedAt: "2026-05-21T00:00:01.000Z",
    reason: "test"
  });
  const taker = storedOrder({ id: "buy", side: "BUY", makerAmount: "60", takerAmount: "100", remainingMaker: "60" });
  const makerSell = storedOrder({
    id: "sell",
    side: "SELL",
    makerAmount: "40",
    takerAmount: "24",
    remainingMaker: "40",
    maker: makerTwo
  });
  store.upsertClobOrder(taker);
  store.upsertClobOrder(makerSell);
  recordMatchResult(store, manualMatchPlan({
    takerOrder: taker,
    makerOrders: [makerSell],
    takerFillAmount: "24",
    makerFillAmounts: ["40"]
  }), transactionHash);

  const app = await testApp(store, {
    getMarketOnChain: async () => storedMarket(),
    getExchangeOrderReadiness: async () => unreadyBuyReadiness(),
    validateExchangeOrder: async () => `0x${"c".repeat(64)}` as Hex,
    getAccountPortfolioBalances: async () => portfolioBalances()
  });
  const response = await app.inject({
    method: "GET",
    url: `/portfolio/${maker}?marketIds=market-1`
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(body.collateral.balance, "700");
  assert.equal(body.orders.open.length, 1);
  assert.equal(body.trades.length, 1);
  assert.equal(body.fills.length, 1);
  assert.equal(body.positions[0].outcomes[1].balance, "80");
  assert.equal(body.positions[0].outcomes[1].redeemable, true);
  await app.close();
});

async function testApp(store: InMemoryStore, clobChain: ClobRouteChain) {
  const app = Fastify({ logger: false });
  await registerRoutes(app, store, new SourceRegistry(), undefined, undefined, clobChain);
  await app.ready();
  return app;
}

function marketStore() {
  const store = new InMemoryStore();
  store.upsertMarket(createYesNoMarket({ id: "market-1", title: "A team to win", status: "open" }));
  return store;
}

function storedMarket() {
  return {
    conditionId: `0x${"d".repeat(64)}` as Hex,
    questionId: `0x${"e".repeat(64)}` as Hex,
    oracle: maker,
    token0: "10",
    token1: "20",
    created: true
  };
}

function portfolioBalances() {
  return {
    account: maker,
    collateral: { address: collateral, balance: "700" },
    markets: [{
      marketId: "market-1",
      conditionId: storedMarket().conditionId,
      token0: "10",
      token1: "20",
      balance0: "0",
      balance1: "80"
    }]
  };
}

function unreadyBuyReadiness(): ExchangeOrderReadiness {
  return buildBuyOrderReadiness({
    marketId: "market-1",
    outcomeSide: "YES",
    maker,
    tokenId: "20",
    exchange,
    collateral,
    requiredAmount: "100",
    balance: "0",
    allowance: "0"
  });
}

function storedOrder(input: {
  id: string;
  side: "BUY" | "SELL";
  makerAmount: string;
  takerAmount: string;
  remainingMaker: string;
  createdAt?: string | undefined;
  status?: StoredClobOrder["status"] | undefined;
  maker?: Address | undefined;
}): StoredClobOrder {
  const createdAt = input.createdAt ?? "2026-05-21T00:00:00.000Z";
  return {
    id: input.id,
    marketId: "market-1",
    outcomeSide: "YES",
    orderHash: (`0x${input.id.padEnd(64, "0").slice(0, 64)}`) as Hex,
    side: input.side,
    remainingMaker: input.remainingMaker,
    status: input.status ?? "open",
    createdAt,
    updatedAt: createdAt,
    order: exchangeOrder({
      tokenId: "20",
      side: input.side === "BUY" ? 0 : 1,
      makerAmount: input.makerAmount,
      takerAmount: input.takerAmount,
      maker: input.maker
    })
  };
}

function exchangeOrder(input: {
  tokenId: string;
  side: 0 | 1;
  makerAmount: string;
  takerAmount: string;
  maker?: Address | undefined;
}): ExchangeOrder {
  return {
    salt: "1",
    maker: input.maker ?? maker,
    signer: input.maker ?? maker,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: input.tokenId,
    makerAmount: input.makerAmount,
    takerAmount: input.takerAmount,
    expiration: "0",
    nonce: "0",
    feeRateBps: "0",
    side: input.side,
    signatureType: 0,
    signature: "0x"
  };
}
