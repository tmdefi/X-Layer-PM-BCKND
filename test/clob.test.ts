import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { InMemoryStore } from "../src/api/store.js";
import {
  operatorTransactionRetryPolicy,
  runTrackedOperatorTransaction
} from "../src/api/operator-transactions.js";
import { createOperatorTransactionRecoveryWorker } from "../src/operator-recovery/index.js";
import { registerRoutes, type ClobRouteChain } from "../src/api/routes.js";
import { erc1155ConditionalTokensAbi, erc20CollateralAbi } from "../src/chain/abis.js";
import { env } from "../src/config/env.js";
import {
  buildBuyOrderReadiness,
  buildSellOrderReadiness,
  type ExchangeOrderReadiness
} from "../src/chain/exchange.js";
import {
  createFootballFixtureMarkets,
  createMainCardPlayerMarket,
  createMmaFixtureMarkets,
  createPlayerTournamentFutureMarket,
  createYesNoMarket
} from "../src/markets/definitions.js";
import { footballLiveTradingCloseReason } from "../src/markets/live-trading.js";
import {
  computeEarlyResolutionDecision,
  computeResolutionDecision,
  confirmEarlyResolutionDecision
} from "../src/markets/resolution.js";
import { SourceRegistry } from "../src/sources/index.js";
import { ApiFootballSource } from "../src/sources/api-football.js";
import { ApiMmaSource } from "../src/sources/api-mma.js";
import { createSettlementWorker } from "../src/settlement/index.js";
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

test("wallet config exposes X Layer connection data without backend secrets", async () => {
  const app = await testApp(marketStore(), readyClobChain());
  const response = await app.inject({ method: "GET", url: "/wallet/config" });
  const config = response.json();

  assert.equal(response.statusCode, 200);
  assert.ok(config.chain.id > 0);
  assert.equal(config.chain.hexId, `0x${config.chain.id.toString(16)}`);
  assert.equal(config.walletAddEthereumChain.chainId, config.chain.hexId);
  assert.equal(config.clobOrderSigning.primaryType, "Order");
  assert.equal(config.privateKey, undefined);
  assert.equal(config.operatorApiKey, undefined);
  await app.close();
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
    getAccountPortfolioBalances: async () => portfolioBalances(),
    redemptionTransaction: async () => redeemTransaction()
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

test("order readiness rejects a lifecycle-open market when trading is closed", async () => {
  const store = marketStore();
  const market = store.getMarket("market-1");
  assert.ok(market);
  store.updateMarket({
    ...market,
    tradingStatus: "closed",
    tradingStatusReason: "Live result is known",
    tradingStatusUpdatedAt: "2026-05-21T00:01:00.000Z"
  });
  const app = await testApp(store, {
    getMarketOnChain: async () => storedMarket(),
    getExchangeOrderReadiness: async () => unreadyBuyReadiness(),
    validateExchangeOrder: async () => `0x${"c".repeat(64)}` as Hex,
    getAccountPortfolioBalances: async () => portfolioBalances(),
    redemptionTransaction: async () => redeemTransaction()
  });
  const response = await app.inject({
    method: "POST",
    url: "/clob/orders/readiness",
    payload: {
      marketId: "market-1",
      outcomeSide: "YES",
      maker,
      side: "BUY",
      makerAmount: "100"
    }
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "Market trading is closed: Live result is known");
  await app.close();
});

test("football live lock rules close determined in-play markets", () => {
  const fixture = {
    id: "live-fixture",
    sport: "football" as const,
    source: { provider: "api-football", externalFixtureId: "99" },
    homeCompetitor: "Home FC",
    awayCompetitor: "Away FC",
    kickoffTime: "2026-06-11T19:00:00.000Z",
    status: "live" as const
  };
  const markets = createFootballFixtureMarkets(fixture, { status: "open" });
  const result = {
    fixtureId: fixture.id,
    source: fixture.source,
    status: "live" as const,
    score: { homeGoals: 1, awayGoals: 1 },
    halfTimeScore: { homeGoals: 1, awayGoals: 0 },
    homeTeamScoredFirst: true,
    observedAt: "2026-06-11T20:00:00.000Z"
  };

  assert.equal(
    footballLiveTradingCloseReason(markets.find((market) => market.id.endsWith(":first-half-draw"))!, result),
    "First-half result is known"
  );
  assert.equal(
    footballLiveTradingCloseReason(markets.find((market) => market.id.endsWith(":home-team-score-first"))!, result),
    "First goal is known"
  );
  assert.equal(
    footballLiveTradingCloseReason(markets.find((market) => market.type === "BOTH_TEAMS_TO_SCORE")!, result),
    "Both teams have scored"
  );
  assert.equal(
    footballLiveTradingCloseReason(markets.find((market) => market.type === "TOTAL_GOALS" && market.line === "1.5")!, result),
    "Total goals already exceed line 1.5"
  );
  assert.equal(
    footballLiveTradingCloseReason(markets.find((market) => market.id.endsWith(":home-team-win"))!, result),
    undefined
  );
  assert.equal(
    computeEarlyResolutionDecision(markets.find((market) => market.id.endsWith(":home-team-score-first"))!, result)?.outcome,
    "YES"
  );
  assert.equal(
    computeEarlyResolutionDecision(markets.find((market) => market.type === "TOTAL_GOALS" && market.line === "1.5")!, result)?.outcome,
    "OVER"
  );
  assert.equal(
    computeEarlyResolutionDecision(markets.find((market) => market.type === "BOTH_TEAMS_TO_SCORE")!, result)?.outcome,
    "YES"
  );
  const overMarket = markets.find((market) => market.type === "TOTAL_GOALS" && market.line === "1.5")!;
  const firstOverObservation = computeEarlyResolutionDecision(overMarket, result);
  assert.equal(firstOverObservation?.earlyResolution?.policy, "REPEATED_SCORE");
  assert.equal(firstOverObservation?.earlyResolution?.observationCount, 1);
  assert.equal(firstOverObservation?.earlyResolution?.confirmedAt, undefined);
  const confirmedOver = confirmEarlyResolutionDecision(
    firstOverObservation,
    computeEarlyResolutionDecision(overMarket, {
      ...result,
      score: { homeGoals: 2, awayGoals: 1 },
      observedAt: "2026-06-11T20:01:00.000Z"
    })!
  );
  assert.equal(confirmedOver.earlyResolution?.observationCount, 2);
  assert.ok(confirmedOver.earlyResolution?.confirmedAt);

  const playerMarket = createMainCardPlayerMarket({
    fixture,
    playerId: "7",
    playerName: "Scorer One",
    teamSide: "home",
    template: "ANYTIME_GOALSCORER",
    status: "open"
  });
  assert.equal(
    computeEarlyResolutionDecision(playerMarket, {
      ...result,
      scoringPlayers: [{
        provider: "api-football",
        playerId: "7",
        playerName: "Scorer One",
        teamSide: "home"
      }]
    })?.outcome,
    "YES"
  );
  assert.equal(
    computeEarlyResolutionDecision(playerMarket, {
      ...result,
      scoringPlayerNames: ["Scorer One"]
    }),
    undefined
  );
  assert.equal(
    computeEarlyResolutionDecision(playerMarket, {
      ...result,
      scoringPlayers: [{
        provider: "api-football",
        playerName: "Scorer One",
        teamSide: "home"
      }]
    }),
    undefined
  );
});

test("settlement worker defers far scheduled fixtures and throttles near-kickoff fallback checks", async () => {
  const store = new InMemoryStore();
  const registry = new SourceRegistry();
  let resultChecks = 0;
  registry.register({
    provider: "test",
    listFixtures: async () => [],
    listLiveFixtures: async () => [],
    getFixtureResult: async (externalFixtureId) => {
      resultChecks += 1;
      return {
        fixtureId: `test:${externalFixtureId}`,
        source: { provider: "test", externalFixtureId },
        status: "scheduled",
        observedAt: "2026-05-21T00:00:00.000Z"
      };
    }
  });

  const farFixture = footballFixture("far", new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
  store.upsertFixture(farFixture);
  store.upsertMarkets(createFootballFixtureMarkets(farFixture, { status: "open" }));
  const worker = createSettlementWorker({
    store,
    sourceRegistry: registry,
    nearKickoffWindowMinutes: 180,
    nearKickoffFallbackIntervalSeconds: 300
  });

  const farRun = await worker.runOnce();
  assert.equal(resultChecks, 0);
  assert.equal(farRun.checkedFixtures, 0);
  assert.equal(farRun.deferredScheduledMarkets, 12);

  const nearFixture = footballFixture("near", new Date(Date.now() + 30 * 60 * 1000).toISOString());
  store.upsertFixture(nearFixture);
  store.upsertMarkets(createFootballFixtureMarkets(nearFixture, { status: "open" }));
  const firstNearRun = await worker.runOnce();
  const secondNearRun = await worker.runOnce();

  assert.equal(resultChecks, 1);
  assert.equal(firstNearRun.scheduledFallbackChecks, 1);
  assert.equal(secondNearRun.scheduledFallbackChecks, 0);
  assert.equal(secondNearRun.deferredScheduledMarkets, 24);
});

test("API-Football player candidate cache reuses team rankings across fixture requests", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(`${url.pathname}?${url.searchParams.toString()}`);

    if (url.pathname === "/fixtures") {
      return jsonResponse([apiFootballFixture()]);
    }

    if (url.pathname === "/players") {
      return jsonResponse([apiFootballPlayer(Number(url.searchParams.get("team")) || 10)]);
    }

    throw new Error(`Unexpected API-Football test path: ${url.pathname}`);
  };

  try {
    const store = new InMemoryStore();
    const source = new ApiFootballSource("test-key", "https://football.test");
    const first = await source.listPlayerCandidates({
      externalFixtureId: "88",
      limitPerTeam: 1,
      cache: store
    });
    const second = await source.listPlayerCandidates({
      externalFixtureId: "89",
      limitPerTeam: 1,
      cache: store
    });

    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.equal(paths.filter((path) => path.startsWith("/players?")).length, 2);
    assert.equal(store.playerCandidates.size, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API-MMA maps UFC fights into fighter winner markets and results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/fights") {
      return jsonResponse([apiMmaFight()]);
    }
    throw new Error(`Unexpected API-MMA test path: ${url.pathname}`);
  };

  try {
    const source = new ApiMmaSource("test-key", "https://mma.test", "UFC");
    const [fixture] = await source.listFixtures({ sport: "mma", from: "2026-06-20" });
    assert.ok(fixture);
    assert.equal(fixture.id, "api-mma:700");
    assert.equal(fixture.competition?.name, "UFC 330");
    assert.equal(fixture.homeCompetitor, "Fighter Red");
    assert.equal(fixture.awayCompetitor, "Fighter Blue");

    const markets = createMmaFixtureMarkets(fixture, { status: "open" });
    assert.deepEqual(markets.map((market) => market.id), [
      "api-mma:700:home-team-win",
      "api-mma:700:away-team-win"
    ]);

    const result = await source.getFixtureResult("700");
    assert.deepEqual(result.score, { homeGoals: 1, awayGoals: 0 });
    assert.equal(computeResolutionDecision(markets[0]!, result).outcome, "YES");
    assert.equal(computeResolutionDecision(markets[1]!, result).outcome, "NO");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MMA winner markets void a finished fight without one fighter winner", () => {
  const fixture = {
    id: "api-mma:draw",
    sport: "mma" as const,
    source: { provider: "api-mma", externalFixtureId: "draw" },
    homeCompetitor: "Fighter One",
    awayCompetitor: "Fighter Two",
    kickoffTime: "2026-06-20T22:00:00.000Z",
    status: "finished" as const
  };
  const [market] = createMmaFixtureMarkets(fixture);
  assert.ok(market);

  const decision = computeResolutionDecision(market, {
    fixtureId: fixture.id,
    source: fixture.source,
    status: "finished",
    score: { homeGoals: 0, awayGoals: 0 },
    observedAt: "2026-06-20T23:00:00.000Z"
  });

  assert.equal(decision.outcome, "VOID");
  assert.deepEqual(decision.payoutVector, [1, 1]);
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

test("operator and market mutation endpoints are protected", async () => {
  const app = await testApp(marketStore(), {
    getMarketOnChain: async () => storedMarket(),
    getExchangeOrderReadiness: async () => unreadyBuyReadiness(),
    validateExchangeOrder: async () => `0x${"c".repeat(64)}` as Hex,
    getAccountPortfolioBalances: async () => portfolioBalances(),
    redemptionTransaction: async () => redeemTransaction()
  });

  const match = await app.inject({ method: "POST", url: "/clob/matches", payload: {} });
  const tick = await app.inject({ method: "POST", url: "/clob/matcher/tick", payload: {} });
  const transactions = await app.inject({ method: "GET", url: "/operator/transactions" });
  const retry = await app.inject({
    method: "POST",
    url: "/operator/transactions/retry-resolution/retry-resolution"
  });
  const sync = await app.inject({ method: "POST", url: "/sync/current" });
  const settlement = await app.inject({ method: "POST", url: "/settlement/tick" });
  const persistedSourceFixtures = await app.inject({
    method: "GET",
    url: "/sources/test/fixtures?persist=true"
  });
  const sourceMarketCreation = await app.inject({
    method: "GET",
    url: "/sources/test/fixtures/current?createMarkets=true"
  });
  const fixture = await app.inject({ method: "POST", url: "/fixtures", payload: {} });
  const generatedMarkets = await app.inject({
    method: "POST",
    url: "/fixtures/fixture-1/markets",
    payload: {}
  });
  const yesNo = await app.inject({ method: "POST", url: "/markets/yes-no", payload: {} });
  const createOnChain = await app.inject({
    method: "POST",
    url: "/markets/market-1/create-on-chain",
    payload: {}
  });
  const resolve = await app.inject({
    method: "POST",
    url: "/markets/market-1/resolve",
    payload: {}
  });
  const review = await app.inject({
    method: "POST",
    url: "/markets/market-1/review-resolution"
  });
  const submit = await app.inject({
    method: "POST",
    url: "/markets/market-1/submit-resolution",
    payload: {}
  });

  for (const response of [
    match,
    tick,
    transactions,
    retry,
    sync,
    settlement,
    persistedSourceFixtures,
    sourceMarketCreation,
    fixture,
    generatedMarkets,
    yesNo,
    createOnChain,
    resolve,
    review,
    submit
  ]) {
    assert.ok([401, 503].includes(response.statusCode));
  }
  await app.close();
});

test("resolution submission requires API review", async () => {
  const originalApiKey = env.CLOB_OPERATOR_API_KEY;
  env.CLOB_OPERATOR_API_KEY = "test-operator-api-key";

  try {
    const store = marketStore();
    const market = store.getMarket("market-1");
    assert.ok(market);
    store.upsertResolution(computeResolutionDecision(market, {
      fixtureId: "market-1",
      source: { provider: "test" },
      status: "finished",
      explicitOutcome: "YES",
      observedAt: "2026-05-21T00:00:00.000Z"
    }));

    const app = await testApp(store, readyClobChain());
    const headers = { "x-operator-api-key": env.CLOB_OPERATOR_API_KEY };
    const submitComputed = await app.inject({
      method: "POST",
      url: "/markets/market-1/submit-resolution",
      headers,
      payload: {}
    });
    const review = await app.inject({
      method: "POST",
      url: "/markets/market-1/review-resolution",
      headers
    });

    assert.equal(submitComputed.statusCode, 409);
    assert.equal(submitComputed.json().error, "Resolution must be reviewed before submission");
    assert.equal(review.statusCode, 201);
    assert.equal(review.json().status, "reviewed");
    assert.equal(store.getResolution("market-1")?.status, "reviewed");
    await app.close();
  } finally {
    env.CLOB_OPERATOR_API_KEY = originalApiKey;
  }
});

test("operator transaction ledger records pending confirmation and failures", async () => {
  const store = new InMemoryStore();
  const result = await runTrackedOperatorTransaction(store, {
    action: "SUBMIT_RESOLUTION",
    entityId: "market-1",
    metadata: { marketId: "market-1" },
    execute: async (onSubmitted) => {
      onSubmitted(transactionHash);
      return "confirmed";
    }
  });

  assert.equal(result, "confirmed");
  const confirmed = store.listOperatorTransactions()[0];
  assert.equal(confirmed?.status, "confirmed");
  assert.equal(confirmed?.txHash, transactionHash);
  assert.ok(confirmed?.submittedAt);
  assert.ok(confirmed?.confirmedAt);

  await assert.rejects(
    runTrackedOperatorTransaction(store, {
      action: "CREATE_MARKET",
      entityId: "broken-market",
      execute: async () => {
        throw new Error("rpc failed");
      }
    }),
    /rpc failed/
  );
  const failed = store.listOperatorTransactions({ action: "CREATE_MARKET" })[0];
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "rpc failed");
  assert.ok(failed?.failedAt);
});

test("operator retry policy keeps broadcast errors recoverable and gates resolution resubmits", async () => {
  const store = new InMemoryStore();
  await assert.rejects(
    runTrackedOperatorTransaction(store, {
      action: "MATCH_ORDERS",
      entityId: "match-after-hash",
      execute: async (onSubmitted) => {
        onSubmitted(transactionHash);
        throw new Error("receipt polling timed out");
      }
    }),
    /receipt polling timed out/
  );

  const broadcast = store.listOperatorTransactions({ action: "MATCH_ORDERS" })[0];
  assert.equal(broadcast?.status, "pending");
  assert.equal(broadcast?.txHash, transactionHash);
  assert.equal(operatorTransactionRetryPolicy(broadcast!).disposition, "wait_for_recovery");

  const failedResolution = store.upsertOperatorTransaction({
    id: "resolution-before-hash",
    action: "SUBMIT_RESOLUTION",
    entityId: "market-1",
    status: "failed",
    error: "rpc unavailable"
  });
  const retryPolicy = operatorTransactionRetryPolicy(failedResolution);
  assert.equal(retryPolicy.disposition, "manual_resolution_retry");
  assert.equal(retryPolicy.retryable, true);

  const revertedResolution = store.upsertOperatorTransaction({
    ...failedResolution,
    id: "resolution-reverted",
    txHash: `0x${"d".repeat(64)}` as Hex
  });
  assert.equal(operatorTransactionRetryPolicy(revertedResolution).retryable, false);
});

test("operator recovery confirms pending receipts and reconciles market or resolution state", async () => {
  const store = marketStore();
  const market = store.getMarket("market-1");
  assert.ok(market);
  store.upsertResolution({
    marketId: market.id,
    marketType: "YES_NO",
    outcome: "YES",
    payoutVector: [0, 1],
    status: "computed",
    source: { provider: "test" },
    observedAt: "2026-05-21T00:00:00.000Z",
    computedAt: "2026-05-21T00:00:01.000Z",
    reason: "test"
  });
  store.upsertOperatorTransaction({
    id: "resolution-tx",
    action: "SUBMIT_RESOLUTION",
    entityId: market.id,
    status: "pending",
    txHash: transactionHash
  });
  store.upsertOperatorTransaction({
    id: "market-tx",
    action: "CREATE_MARKET",
    entityId: market.id,
    status: "pending",
    txHash: `0x${"b".repeat(64)}` as Hex
  });
  store.upsertOperatorTransaction({
    id: "revert-tx",
    action: "MATCH_ORDERS",
    entityId: "match-1",
    status: "pending",
    txHash: `0x${"c".repeat(64)}` as Hex
  });
  const worker = createOperatorTransactionRecoveryWorker({
    store,
    chain: {
      getTransactionReceipt: async (hash) => receipt(hash === `0x${"c".repeat(64)}` ? "reverted" : "success"),
      getMarketOnChain: async () => storedMarket()
    }
  });

  const summary = await worker.runOnce();

  assert.equal(summary.checked, 3);
  assert.equal(summary.confirmed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.reconciledMarkets, 1);
  assert.equal(summary.reconciledResolutions, 1);
  assert.equal(store.getResolution(market.id)?.status, "submitted");
  assert.equal(store.getMarket(market.id)?.conditionId, storedMarket().conditionId);
  assert.equal(store.getOperatorTransaction("revert-tx")?.status, "failed");
});

test("operator recovery reconstructs a confirmed CLOB match once from saved match metadata", async () => {
  const store = marketStore();
  const taker = storedOrder({
    id: "recover-buy",
    side: "BUY",
    makerAmount: "60",
    takerAmount: "100",
    remainingMaker: "60"
  });
  const makerOrder = storedOrder({
    id: "recover-sell",
    side: "SELL",
    makerAmount: "40",
    takerAmount: "24",
    remainingMaker: "40",
    maker: makerTwo
  });
  store.upsertClobOrder(taker);
  store.upsertClobOrder(makerOrder);
  store.upsertOperatorTransaction({
    id: "recover-match",
    action: "MATCH_ORDERS",
    entityId: "recover-buy:recover-sell:24:40",
    status: "pending",
    txHash: transactionHash,
    metadata: {
      marketId: "market-1",
      takerOrderId: taker.id,
      makerOrderIds: [makerOrder.id],
      takerFillAmount: "24",
      makerFillAmounts: ["40"],
      shareSize: "40"
    }
  });
  const worker = createOperatorTransactionRecoveryWorker({
    store,
    chain: {
      getTransactionReceipt: async () => receipt("success"),
      getMarketOnChain: async () => storedMarket()
    }
  });

  const first = await worker.runOnce();
  const second = await worker.runOnce();
  const recovered = store.getOperatorTransaction("recover-match")?.result as {
    recoveredMatch?: { tradeId: string; orders: { id: string; status: string }[] };
  };

  assert.equal(first.recoveredMatches, 1);
  assert.equal(first.recoveredTrades[0]?.txHash, transactionHash);
  assert.equal(second.recoveredMatches, 0);
  assert.equal(store.listClobTrades("market-1").length, 1);
  assert.equal(store.listClobFills().length, 2);
  assert.equal(store.getClobOrder(taker.id)?.remainingMaker, "36");
  assert.equal(store.getClobOrder(makerOrder.id)?.status, "filled");
  assert.ok(recovered.recoveredMatch?.tradeId);
  assert.equal(recovered.recoveredMatch?.orders[1]?.status, "filled");
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
    getAccountPortfolioBalances: async () => portfolioBalances(),
    redemptionTransaction: async () => redeemTransaction()
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
  assert.equal(body.positions[0].outcomes[1].averagePrice, "0.6");
  assert.equal(body.positions[0].outcomes[1].currentPrice, "1");
  assert.equal(body.positions[0].outcomes[1].costBasis, "48");
  assert.equal(body.positions[0].outcomes[1].currentValue, "80");
  assert.equal(body.positions[0].outcomes[1].unrealizedPnl, "32");
  assert.equal(body.positions[0].outcomes[1].redeemable, true);
  const redemption = await app.inject({
    method: "POST",
    url: "/markets/market-1/redeem-transaction"
  });
  assert.equal(redemption.statusCode, 200);
  assert.equal(redemption.json().transaction.to, ctf);
  await app.close();
});

test("market event hub emits trading, early resolution, and redeemable transitions", () => {
  const store = marketStore();
  const events: string[] = [];
  const unsubscribe = store.marketEvents.subscribe((event) => {
    events.push(event.type);
  });
  const market = store.getMarket("market-1");
  assert.ok(market);

  store.updateMarket({
    ...market,
    tradingStatus: "closed",
    tradingStatusReason: "Live result is known",
    tradingStatusUpdatedAt: "2026-05-21T00:01:00.000Z"
  });
  const earlyResolution = {
    marketId: "market-1",
    marketType: "YES_NO" as const,
    outcome: "YES" as const,
    payoutVector: [0, 1] as const,
    status: "computed" as const,
    source: { provider: "api-football" },
    observedAt: "2026-05-21T00:01:00.000Z",
    computedAt: "2026-05-21T00:01:01.000Z",
    reason: "Confirmed live scorer",
    earlyResolution: {
      policy: "STABLE_PLAYER_SCORER" as const,
      evidenceKey: "market-1:api-football:7",
      observationCount: 1,
      firstObservedAt: "2026-05-21T00:01:00.000Z",
      lastObservedAt: "2026-05-21T00:01:00.000Z"
    }
  };
  store.upsertResolution(earlyResolution);
  store.upsertResolution({
    ...earlyResolution,
    status: "submitted",
    earlyResolution: {
      ...earlyResolution.earlyResolution,
      observationCount: 2,
      lastObservedAt: "2026-05-21T00:02:00.000Z",
      confirmedAt: "2026-05-21T00:02:01.000Z"
    }
  });
  unsubscribe();

  assert.deepEqual(events, [
    "market.trading_status_changed",
    "market.early_resolution_candidate",
    "market.resolution_submitted",
    "market.redeemable"
  ]);
});

test("market data routes expose frontend prices, ticks, summaries, and candles", async () => {
  const store = marketStore();
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
    getAccountPortfolioBalances: async () => portfolioBalances(),
    redemptionTransaction: async () => redeemTransaction()
  });
  const [price, trades, chart, summary] = await Promise.all([
    app.inject({ method: "GET", url: "/markets/market-1/price" }),
    app.inject({ method: "GET", url: "/markets/market-1/trades?limit=1" }),
    app.inject({ method: "GET", url: "/markets/market-1/chart?interval=1h" }),
    app.inject({ method: "GET", url: "/markets/market-1/summary" })
  ]);

  assert.equal(price.statusCode, 200);
  assert.equal(price.json().prices.YES.lastTradePrice, "0.6");
  assert.equal(price.json().prices.YES.volume, "24");
  assert.equal(trades.json().ticks[0].shareAmount, "40");
  assert.equal(trades.json().ticks[0].collateralAmount, "24");
  assert.equal(chart.json().interval, "1h");
  assert.equal(chart.json().candles.YES[0].close, "0.6");
  assert.equal(chart.json().candles.YES[0].tradeCount, 1);
  assert.equal(summary.json().summary.openOrderCount, 1);
  assert.equal(summary.json().summary.shareVolume, "40");
  await app.close();
});

test("market summary list and card feed batch frontend snippets", async () => {
  const store = marketStore();
  store.upsertFixture({
    id: "fixture-1",
    sport: "football",
    source: { provider: "test", externalFixtureId: "fixture-1" },
    competition: { kind: "league", id: "premier-league", name: "Premier League", season: "2026" },
    homeCompetitor: "Home FC",
    awayCompetitor: "Away FC",
    kickoffTime: "2026-05-22T18:00:00.000Z",
    status: "scheduled"
  });
  store.upsertMarket(createYesNoMarket({
    id: "fixture-market",
    fixtureId: "fixture-1",
    title: "Home FC to win",
    status: "open"
  }));
  store.upsertMarket(createYesNoMarket({
    id: "player-market",
    fixtureId: "fixture-1",
    title: "Striker One to score a hat trick",
    status: "open",
    template: {
      category: "PLAYER",
      template: "HAT_TRICK",
      player: {
        provider: "test",
        playerId: "striker-one",
        playerName: "Striker One",
        teamSide: "home"
      }
    }
  }));
  store.upsertFixture({
    id: "fixture-2",
    sport: "football",
    source: { provider: "test", externalFixtureId: "fixture-2" },
    competition: { kind: "league", id: "champions-league", name: "Champions League", season: "2026" },
    homeCompetitor: "Live FC",
    awayCompetitor: "Away Town",
    kickoffTime: "2026-05-23T18:00:00.000Z",
    status: "live"
  });
  store.upsertMarket(createYesNoMarket({
    id: "live-market",
    fixtureId: "fixture-2",
    title: "Live FC to win",
    status: "open"
  }));
  const liveBuy = storedOrder({
    id: "live-buy",
    marketId: "live-market",
    side: "BUY",
    makerAmount: "36",
    takerAmount: "60",
    remainingMaker: "36"
  });
  const liveSell = storedOrder({
    id: "live-sell",
    marketId: "live-market",
    side: "SELL",
    makerAmount: "60",
    takerAmount: "36",
    remainingMaker: "60",
    maker: makerTwo
  });
  store.upsertClobOrder(liveBuy);
  store.upsertClobOrder(liveSell);
  recordMatchResult(store, manualMatchPlan({
    takerOrder: liveBuy,
    makerOrders: [liveSell],
    takerFillAmount: "36",
    makerFillAmounts: ["60"]
  }), transactionHash);

  const app = await testApp(store, {
    getMarketOnChain: async () => storedMarket(),
    getExchangeOrderReadiness: async () => unreadyBuyReadiness(),
    validateExchangeOrder: async () => `0x${"c".repeat(64)}` as Hex,
    getAccountPortfolioBalances: async () => portfolioBalances(),
    redemptionTransaction: async () => redeemTransaction()
  });
  const [summaries, cards, kickoffPage, volume, activity, search, playerCards, standalone, competition] = await Promise.all([
    app.inject({ method: "GET", url: "/markets/summaries?status=open&limit=10" }),
    app.inject({ method: "GET", url: "/markets/cards?sort=live_status" }),
    app.inject({ method: "GET", url: "/markets/cards?sort=kickoff_time&offset=2&limit=1" }),
    app.inject({ method: "GET", url: "/markets/summaries?sort=volume&limit=1" }),
    app.inject({ method: "GET", url: "/markets/summaries?sort=newest_activity&limit=1" }),
    app.inject({ method: "GET", url: "/markets/summaries?q=Away%20Town&provider=test&fixtureStatus=live" }),
    app.inject({ method: "GET", url: "/markets/cards?category=player" }),
    app.inject({ method: "GET", url: "/markets/summaries?category=standalone&marketType=YES_NO" }),
    app.inject({ method: "GET", url: "/markets/cards?competitionId=premier-league&competitionName=premier" })
  ]);

  assert.equal(summaries.statusCode, 200);
  assert.equal(summaries.json().summaries.length, 4);
  assert.equal(summaries.json().summaries[0].summary.openOrderCount, 0);
  assert.equal(cards.statusCode, 200);
  assert.equal(cards.json().cards.length, 4);
  assert.equal(cards.json().cards[0].type, "MATCH");
  assert.equal(cards.json().cards[0].fixture.id, "fixture-2");
  assert.equal(cards.json().cards[1].fixture.id, "fixture-1");
  assert.equal(cards.json().cards[2].type, "PLAYER");
  assert.equal(cards.json().cards[3].type, "MARKET");
  assert.equal(kickoffPage.json().cards[0].fixture.id, "fixture-2");
  assert.equal(kickoffPage.json().pagination.total, 4);
  assert.equal(kickoffPage.json().pagination.hasMore, true);
  assert.equal(kickoffPage.json().pagination.nextOffset, 3);
  assert.equal(volume.json().summaries[0].market.id, "live-market");
  assert.equal(activity.json().summaries[0].market.id, "live-market");
  assert.equal(search.json().summaries.length, 1);
  assert.equal(search.json().summaries[0].market.id, "live-market");
  assert.equal(playerCards.json().cards.length, 1);
  assert.equal(playerCards.json().cards[0].type, "PLAYER");
  assert.equal(playerCards.json().cards[0].summaries[0].market.id, "player-market");
  assert.equal(standalone.json().summaries.length, 1);
  assert.equal(standalone.json().summaries[0].market.id, "market-1");
  assert.equal(competition.json().cards.length, 2);
  assert.equal(competition.json().cards[0].fixture.competition.name, "Premier League");
  await app.close();
});

test("player future markets are discoverable and resolve from tournament aggregate stats", async () => {
  const store = new InMemoryStore();
  const market = createPlayerTournamentFutureMarket({
    provider: "api-football",
    competition: {
      kind: "league",
      id: "1",
      name: "World Cup",
      season: "2026"
    },
    playerId: "278",
    playerName: "Kylian Mbappe",
    teamName: "France",
    imageUrl: "https://media.api-sports.io/football/players/278.png",
    template: "TOURNAMENT_GOALS_OVER",
    line: "4.5",
    status: "open"
  });
  store.upsertMarket(market);

  const decision = computeResolutionDecision(market, {
    source: {
      provider: "api-football",
      externalFixtureId: "1"
    },
    fixtureId: "world-cup-2026",
    status: "finished",
    tournamentPlayerStats: [{
      provider: "api-football",
      playerId: "278",
      playerName: "Kylian Mbappe",
      goals: 5
    }],
    observedAt: "2026-07-20T00:00:00.000Z"
  });

  assert.equal(decision.outcome, "YES");
  assert.deepEqual(decision.payoutVector, [0, 1]);
  assert.match(decision.reason, /5 goals vs line 4.5/);

  const app = await testApp(store, readyClobChain());
  const cards = await app.inject({ method: "GET", url: "/markets/cards?category=player_future&competitionName=World%20Cup" });
  assert.equal(cards.statusCode, 200);
  assert.equal(cards.json().cards.length, 1);
  assert.equal(cards.json().cards[0].type, "PLAYER_FUTURE");
  assert.equal(cards.json().cards[0].player.playerName, "Kylian Mbappe");
  assert.equal(cards.json().cards[0].competition.name, "World Cup");
  await app.close();
});

async function testApp(store: InMemoryStore, clobChain: ClobRouteChain) {
  const app = Fastify({ logger: false });
  await registerRoutes(app, store, new SourceRegistry(), undefined, undefined, clobChain);
  await app.ready();
  return app;
}

function readyClobChain(): ClobRouteChain {
  return {
    getMarketOnChain: async () => storedMarket(),
    getExchangeOrderReadiness: async () => unreadyBuyReadiness(),
    validateExchangeOrder: async () => transactionHash,
    getAccountPortfolioBalances: async () => portfolioBalances(),
    redemptionTransaction: async () => redeemTransaction()
  };
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

function footballFixture(id: string, kickoffTime: string) {
  return {
    id: `test:${id}`,
    sport: "football" as const,
    source: { provider: "test", externalFixtureId: id },
    homeCompetitor: `${id} Home`,
    awayCompetitor: `${id} Away`,
    kickoffTime,
    status: "scheduled" as const
  };
}

function apiFootballFixture() {
  return {
    fixture: {
      id: 88,
      date: "2026-06-11T19:00:00.000Z",
      timestamp: Math.floor(Date.parse("2026-06-11T19:00:00.000Z") / 1000),
      status: { short: "NS" }
    },
    league: { id: 1, name: "World Cup", season: 2026 },
    teams: {
      home: { id: 10, name: "Home" },
      away: { id: 11, name: "Away" }
    },
    goals: { home: null, away: null }
  };
}

function apiFootballPlayer(teamId: number) {
  return {
    player: { id: teamId * 100, name: `Player ${teamId}` },
    statistics: [{
      team: { id: teamId, name: `Team ${teamId}` },
      games: { appearances: 5, minutes: 450, position: "Attacker" },
      shots: { on: 6 },
      goals: { total: 3, assists: 1 }
    }]
  };
}

function apiMmaFight() {
  return {
    id: 700,
    date: "2026-06-20T22:00:00.000Z",
    status: { short: "FT" },
    slug: "UFC 330",
    category: "Lightweight",
    fighters: {
      first: { id: 1, name: "Fighter Red", winner: true },
      second: { id: 2, name: "Fighter Blue", winner: false }
    }
  };
}

function jsonResponse(response: unknown[]) {
  return new Response(JSON.stringify({ response, paging: { current: 1, total: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
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

function redeemTransaction() {
  return {
    to: ctf,
    data: `0x${"f".repeat(64)}` as Hex
  };
}

function receipt(status: "success" | "reverted") {
  return {
    status
  } as Awaited<ReturnType<NonNullable<Parameters<typeof createOperatorTransactionRecoveryWorker>[0]["chain"]>["getTransactionReceipt"]>>;
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
  marketId?: string | undefined;
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
    marketId: input.marketId ?? "market-1",
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
