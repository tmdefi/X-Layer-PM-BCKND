import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import {
  cancellationTransaction,
  createMarketOnChain,
  getExchangeNonce,
  getExchangeOrderStatus,
  getExchangeOrderReadiness,
  getAccountPortfolioBalances,
  getMarketOnChain,
  marketUsesCurrentCollateral,
  createPublicChainClient,
  requireAddress,
  hashIdentifier,
  incrementNonceTransaction,
  collateralTransferTransaction,
  outcomeSideToResolverOutcome,
  prepareExchangeOrder,
  redemptionTransaction,
  resolveMarketOnChain,
  validateExchangeOrder,
  exchangeDomain,
  xLayerChain
} from "../chain/index.js";
import { env } from "../config/env.js";
import {
  MAIN_CARD_PLAYER_MARKET_TEMPLATES,
  PLAYER_MARKET_TEMPLATES,
  PLAYER_TOURNAMENT_FUTURE_OVER_LINES,
  PLAYER_TOURNAMENT_FUTURE_TEMPLATES,
  createBasketballFixtureMarkets,
  createEsportsFixtureMarkets,
  createFootballFixtureMarkets,
  createMmaFixtureMarkets,
  createMainCardPlayerMarket,
  createPlayerMarket,
  createPlayerTournamentFutureMarket,
  createYesNoMarket
} from "../markets/definitions.js";
import { computeResolutionDecision } from "../markets/resolution.js";
import { markResolutionReviewed } from "../resolution/index.js";
import type {
  BasketballFixture,
  EsportsFixture,
  Fixture,
  FixtureStatus,
  FootballFixture,
  MarketDefinition,
  MmaFixture,
  ResolutionDecision
} from "../markets/types.js";
import type { FixtureInsights, FixtureQuery, SourceRegistry } from "../sources/index.js";
import type { SettlementWorker } from "../settlement/index.js";
import type { ProviderSyncWorker } from "../sync/index.js";
import type { OperatorTransactionRecoveryWorker } from "../operator-recovery/index.js";
import type { InMemoryStore } from "./store.js";
import {
  operatorTransactionRetryPolicy,
  runTrackedOperatorTransaction
} from "./operator-transactions.js";
import { requireClobOperatorApiKey, requireTelegramBotApiKey } from "./security.js";
import {
  exportPrivyWalletPrivateKey,
  getOrCreateExportablePrivyTelegramWallet,
  getOrCreatePrivyTelegramWallet,
  sendPrivyTransaction,
  signPrivyTypedData
} from "../wallets/privy.js";
import {
  autoMatchOrder,
  buildOrderbook,
  executeMatchPlan,
  fillWithHouseLiquidity,
  tickHouseLiquidity,
  marketCandles,
  marketPriceData,
  marketSummaryData,
  marketTradeTicks,
  manualMatchPlan,
  matchRequestError,
  enrichPortfolioPosition,
  portfolioActivity,
  portfolioMarketCandidates,
  tickAutoMatcher
} from "../trading/index.js";
import type { ExchangeOrder, StoredClobOrder } from "../trading/index.js";
import {
  autoMainCardPlayerMarketsSchema,
  addressSchema,
  clobOrderReadinessSchema,
  createMarketOnChainSchema,
  createMainCardPlayerMarketsSchema,
  createPlayerMarketsSchema,
  createPlayerTournamentFuturesSchema,
  currentFixtureQuerySchema,
  createYesNoMarketSchema,
  fixtureSchema,
  generateFixtureMarketsSchema,
  matchClobOrdersSchema,
  marketChartQuerySchema,
  marketListQuerySchema,
  marketTradesQuerySchema,
  prepareClobOrderSchema,
  portfolioQuerySchema,
  providerFixtureResultSchema,
  sourceFixtureQuerySchema,
  submitClobOrderSchema,
  submitMarketResolutionOnChainSchema,
  telegramClaimWinningsSchema,
  telegramPlaceOrderSchema,
  telegramUserSchema,
  telegramWithdrawalSchema,
  tickClobMatcherSchema
} from "./schemas.js";

export type ClobRouteChain = {
  getMarketOnChain: typeof getMarketOnChain;
  getExchangeOrderReadiness: typeof getExchangeOrderReadiness;
  validateExchangeOrder: typeof validateExchangeOrder;
  getAccountPortfolioBalances: typeof getAccountPortfolioBalances;
  redemptionTransaction: typeof redemptionTransaction;
  collateralTransferTransaction: typeof collateralTransferTransaction;
};

const defaultClobRouteChain: ClobRouteChain = {
  getMarketOnChain,
  getExchangeOrderReadiness,
  validateExchangeOrder,
  getAccountPortfolioBalances,
  redemptionTransaction,
  collateralTransferTransaction
};

const EXPORT_TOKEN_TTL_MS = 5 * 60 * 1000;
const exportTokens = new Map<string, {
  walletId: string;
  address: Address;
  telegramUserId: string;
  expiresAt: number;
}>();

export async function registerRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
  sourceRegistry: SourceRegistry,
  settlementWorker?: SettlementWorker,
  syncWorker?: ProviderSyncWorker,
  clobChain: ClobRouteChain = defaultClobRouteChain,
  operatorRecoveryWorker?: OperatorTransactionRecoveryWorker
): Promise<void> {
  app.get("/events/markets", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    writeMarketEvent(reply.raw, {
      id: randomUUID(),
      type: "stream.connected",
      at: new Date().toISOString()
    });

    const unsubscribe = store.marketEvents.subscribe((event) => {
      writeMarketEvent(reply.raw, event);
    });
    const keepAlive = setInterval(() => {
      reply.raw.write(": keep-alive\n\n");
    }, 15_000);
    keepAlive.unref();

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "prediction-market-backend"
  }));

  app.get("/sports", async () => ({
    sports: ["football", "basketball", "american_football", "esports", "mma"]
  }));

  app.get("/wallet/config", async () => walletConnectionConfig());

  app.get("/market-templates/player", async () => ({
    templates: PLAYER_MARKET_TEMPLATES.map(({ template, label }) => ({ template, label }))
  }));

  app.get("/market-templates/main-card-player", async () => ({
    templates: MAIN_CARD_PLAYER_MARKET_TEMPLATES.map(({ template, label }) => ({ template, label }))
  }));

  app.get("/market-templates/player-future", async () => ({
    templates: PLAYER_TOURNAMENT_FUTURE_TEMPLATES.map(({ template, label, requiresLine }) => ({
      template,
      label,
      requiresLine,
      ...(requiresLine ? { lineOptions: PLAYER_TOURNAMENT_FUTURE_OVER_LINES } : {})
    }))
  }));

  app.get("/sources", async () => ({
    providers: sourceRegistry.listProviders()
  }));

  app.get("/settlement/status", async () => ({
    settlement: settlementWorker?.status()
  }));

  app.get("/sync/status", async () => ({
    sync: syncWorker?.status()
  }));

  app.get("/operator/recovery/status", async () => ({
    recovery: operatorRecoveryWorker?.status()
  }));

  app.get<{ Querystring: { limit?: string | undefined } }>("/sync/logs", async (request) => ({
    logs: store.listProviderSyncLogs(Number(request.query.limit ?? 50))
  }));

  app.get<{ Querystring: {
    status?: string | undefined;
    action?: string | undefined;
    entityId?: string | undefined;
    limit?: string | undefined;
  } }>("/operator/transactions", {
    preHandler: requireClobOperatorApiKey
  }, async (request) => {
    const status = operatorTransactionStatus(request.query.status);
    const action = operatorTransactionAction(request.query.action);
    return {
      transactions: store.listOperatorTransactions({
        ...(status ? { status } : {}),
        ...(action ? { action } : {}),
        ...(request.query.entityId ? { entityId: request.query.entityId } : {}),
        limit: Number(request.query.limit ?? 100)
      }).map((transaction) => ({
        ...transaction,
        retryPolicy: operatorTransactionRetryPolicy(transaction)
      }))
    };
  });

  app.post<{ Params: { id: string } }>("/operator/transactions/:id/retry-resolution", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const transaction = store.getOperatorTransaction(request.params.id);
    if (!transaction) {
      return reply.code(404).send({ error: "Operator transaction not found" });
    }

    const retryPolicy = operatorTransactionRetryPolicy(transaction);
    if (transaction.action !== "SUBMIT_RESOLUTION" || retryPolicy.disposition !== "manual_resolution_retry") {
      return reply.code(409).send({
        error: "Only no-hash failed resolution submissions can be retried from this route",
        retryPolicy
      });
    }

    const market = store.getMarket(transaction.entityId);
    const decision = store.getResolution(transaction.entityId);
    if (!market || !decision) {
      return reply.code(409).send({
        error: "The market and computed resolution must still exist before retrying submission",
        retryPolicy
      });
    }
    if (decision.outcome === "VOID") {
      return reply.code(409).send({ error: "VOID resolutions require the void/refund resolver path" });
    }
    if (decision.status !== "reviewed") {
      return reply.code(409).send({ error: "Resolution must be reviewed before submission" });
    }

    const questionId = resolutionQuestionId(transaction.metadata) ?? hashIdentifier(market.id);
    const result = await submitResolutionOperatorTransaction(store, {
      marketId: market.id,
      outcome: decision.outcome,
      questionId,
      metadata: {
        marketId: market.id,
        outcome: decision.outcome,
        questionId,
        source: "operator_retry",
        retryOf: transaction.id
      }
    });
    const submittedDecision: ResolutionDecision = {
      ...decision,
      status: "submitted"
    };
    store.upsertResolution(submittedDecision);

    return reply.code(201).send({
      retryOf: transaction.id,
      resolution: submittedDecision,
      onChain: result
    });
  });

  app.post("/operator/recovery/tick", {
    preHandler: requireClobOperatorApiKey
  }, async (_request, reply) => {
    if (!operatorRecoveryWorker) {
      return reply.code(503).send({ error: "Operator transaction recovery worker is not configured" });
    }

    return reply.code(201).send({ summary: await operatorRecoveryWorker.runOnce() });
  });

  app.post<{ Params: { provider: string } }>("/sync/:provider/current", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    if (!syncWorker) {
      return reply.code(503).send({ error: "Provider sync worker is not configured" });
    }

    const summary = await syncWorker.runOnce(request.params.provider);
    return reply.code(201).send({ summary });
  });

  app.post("/sync/current", {
    preHandler: requireClobOperatorApiKey
  }, async (_request, reply) => {
    if (!syncWorker) {
      return reply.code(503).send({ error: "Provider sync worker is not configured" });
    }

    const summary = await syncWorker.runOnce();
    return reply.code(201).send({ summary });
  });

  app.post("/settlement/tick", {
    preHandler: requireClobOperatorApiKey
  }, async (_request, reply) => {
    if (!settlementWorker) {
      return reply.code(503).send({ error: "Settlement worker is not configured" });
    }

    const summary = await settlementWorker.runOnce();
    return reply.code(201).send({ summary });
  });

  app.get<{ Params: { provider: string }; Querystring: Record<string, string | undefined> }>(
    "/sources/:provider/fixtures",
    async (request, reply) => {
      const query = sourceFixtureQuerySchema.parse(request.query);
      if (query.persist) {
        const authReply = await requireClobOperatorApiKey(request, reply);
        if (authReply) return authReply;
      }

      const sourceQuery: FixtureQuery = {};
      if (query.sport) sourceQuery.sport = query.sport;
      if (query.from) sourceQuery.from = query.from;
      if (query.to) sourceQuery.to = query.to;
      if (query.externalFixtureId) sourceQuery.externalFixtureId = query.externalFixtureId;
      if (query.leagueId) sourceQuery.leagueId = query.leagueId;
      if (query.season) sourceQuery.season = query.season;

      const fixtures = await sourceRegistry.get(request.params.provider).listFixtures(sourceQuery);

      if (query.persist) {
        for (const fixture of fixtures) {
          store.upsertFixture(fixture);
        }
      }

      return reply.send({ fixtures });
    }
  );

  app.get<{ Params: { provider: string }; Querystring: Record<string, string | undefined> }>(
    "/sources/:provider/fixtures/current",
    async (request, reply) => {
      const query = currentFixtureQuerySchema.parse(request.query);
      if (query.persist || query.createMarkets) {
        const authReply = await requireClobOperatorApiKey(request, reply);
        if (authReply) return authReply;
      }

      const sport = query.sport ?? (request.params.provider === "api-football" ? "football" : undefined);
      const dates = currentDateWindow(query.days);
      const sourceQueries = rangeCurrentFixtureProvider(request.params.provider)
        ? [{ from: dates[0]!, to: dates[dates.length - 1]! }]
        : dates.map((date) => ({ from: date }));
      const fixtures = (
        await Promise.all(
          sourceQueries.map((dateQuery) => {
            const sourceQuery: FixtureQuery = { ...dateQuery };
            if (sport) sourceQuery.sport = sport;
            return sourceRegistry.get(request.params.provider).listFixtures(sourceQuery);
          })
        )
      )
        .flat()
        .filter((fixture) => fixture.status === "scheduled" || fixture.status === "live")
        .sort((a, b) => Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime));

      if (query.persist || query.createMarkets) {
        for (const fixture of fixtures) {
          store.upsertFixture(fixture);
        }
      }

      const markets = query.createMarkets
        ? fixtures.flatMap((fixture) => {
            if (fixture.sport === "football") return createFootballFixtureMarkets(fixture as FootballFixture);
            if (fixture.sport === "basketball") return createBasketballFixtureMarkets(fixture as BasketballFixture);
            if (fixture.sport === "mma") return createMmaFixtureMarkets(fixture as MmaFixture);
            if (fixture.sport === "esports") return createEsportsFixtureMarkets(fixture as EsportsFixture);
            return [];
          })
        : [];

      if (markets.length > 0) {
        store.upsertMarkets(markets);
      }

      const insightsByFixtureId = query.includeInsights
        ? await loadFixtureInsights(fixtures, sourceRegistry, store)
        : new Map<string, FixtureInsights>();

      return reply.send({
        fixtures,
        ...(query.includeInsights ? { insights: Object.fromEntries(insightsByFixtureId) } : {}),
        ...(query.createMarkets ? { markets, cards: buildMarketCards(fixtures, markets, insightsByFixtureId) } : {})
      });
    }
  );

  app.get<{ Params: { provider: string; externalFixtureId: string } }>(
    "/sources/:provider/fixtures/:externalFixtureId/result",
    async (request) => {
      const result = await sourceRegistry
        .get(request.params.provider)
        .getFixtureResult(request.params.externalFixtureId);

      return { result };
    }
  );

  app.get<{ Params: { provider: string; externalFixtureId: string } }>(
    "/sources/:provider/fixtures/:externalFixtureId/insights",
    async (request, reply) => {
      const source = sourceRegistry.get(request.params.provider);
      if (!source.getFixtureInsights) {
        return reply.code(400).send({
          error: `Provider ${request.params.provider} does not support fixture insights`
        });
      }

      const insights = await loadProviderFixtureInsights({
        sourceRegistry,
        store,
        provider: request.params.provider,
        externalFixtureId: request.params.externalFixtureId,
        status: "scheduled"
      });

      return { insights };
    }
  );

  app.post("/fixtures", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const fixture = fixtureSchema.parse(request.body);
    return reply.code(201).send(store.upsertFixture(fixture));
  });

  app.get("/fixtures", async () => ({
    fixtures: store.listFixtures()
  }));

  app.get<{ Params: { id: string } }>("/fixtures/:id", async (request, reply) => {
    const fixture = store.getFixture(request.params.id);
    if (!fixture) {
      return reply.code(404).send({ error: "Fixture not found" });
    }

    return fixture;
  });

  app.get<{ Params: { id: string } }>("/fixtures/:id/insights", async (request, reply) => {
    const fixture = store.getFixture(request.params.id);
    if (!fixture) {
      return reply.code(404).send({ error: "Fixture not found" });
    }

    const source = sourceRegistry.get(fixture.source.provider);
    if (!source.getFixtureInsights || !fixture.source.externalFixtureId) {
      return reply.code(400).send({
        error: `Provider ${fixture.source.provider} does not support fixture insights for this fixture`
      });
    }

    const insights = await loadProviderFixtureInsights({
      sourceRegistry,
      store,
      provider: fixture.source.provider,
      externalFixtureId: fixture.source.externalFixtureId,
      status: fixture.status
    });

    return { fixture, insights };
  });

  app.post<{ Params: { id: string } }>("/fixtures/:id/markets", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const fixture = store.getFixture(request.params.id);
    if (!fixture) {
      return reply.code(404).send({ error: "Fixture not found" });
    }

    if (fixture.sport !== "football" && fixture.sport !== "basketball" && fixture.sport !== "mma" && fixture.sport !== "esports") {
      return reply.code(400).send({
        error: "Generated structured markets are currently only supported for football, basketball, MMA, and esports fixtures"
      });
    }

    const options = generateFixtureMarketsSchema.parse(request.body ?? {});
    const markets =
      fixture.sport === "football"
        ? createFootballFixtureMarkets(fixture as FootballFixture, options)
        : fixture.sport === "basketball"
          ? createBasketballFixtureMarkets(fixture as BasketballFixture, options)
          : fixture.sport === "mma"
            ? createMmaFixtureMarkets(fixture as MmaFixture, options)
            : createEsportsFixtureMarkets(fixture as EsportsFixture, options);
    store.upsertMarkets(markets);

    return reply.code(201).send({ markets });
  });

  app.post<{ Params: { id: string } }>("/fixtures/:id/player-markets", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const fixture = store.getFixture(request.params.id);
    if (!fixture) {
      return reply.code(404).send({ error: "Fixture not found" });
    }

    if (fixture.sport !== "football") {
      return reply.code(400).send({
        error: "Player market templates are currently only supported for football fixtures"
      });
    }

    const input = createPlayerMarketsSchema.parse(request.body ?? {});
    const markets = input.markets.map((market) =>
      createPlayerMarket({
        fixture: fixture as FootballFixture,
        playerId: market.playerId,
        playerName: market.playerName,
        teamSide: market.teamSide,
        template: market.template,
        status: input.status
      })
    );
    store.upsertMarkets(markets);

    return reply.code(201).send({
      fixture,
      markets,
      cards: buildMarketCards([fixture], store.listMarkets().filter((market) => market.fixtureId === fixture.id))
    });
  });

  app.post<{ Params: { id: string } }>("/fixtures/:id/main-card-player-markets", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const fixture = store.getFixture(request.params.id);
    if (!fixture) {
      return reply.code(404).send({ error: "Fixture not found" });
    }

    if (fixture.sport !== "football") {
      return reply.code(400).send({
        error: "Main-card player market templates are currently only supported for football fixtures"
      });
    }

    const input = createMainCardPlayerMarketsSchema.parse(request.body ?? {});
    const markets = input.markets.map((market) =>
      createMainCardPlayerMarket({
        fixture: fixture as FootballFixture,
        playerId: market.playerId,
        playerName: market.playerName,
        teamSide: market.teamSide,
        template: market.template,
        status: input.status
      })
    );
    store.upsertMarkets(markets);

    return reply.code(201).send({
      fixture,
      markets,
      cards: buildMarketCards([fixture], store.listMarkets().filter((market) => market.fixtureId === fixture.id))
    });
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    "/fixtures/:id/player-candidates",
    async (request, reply) => {
      const fixture = store.getFixture(request.params.id);
      if (!fixture) {
        return reply.code(404).send({ error: "Fixture not found" });
      }

      const input = autoMainCardPlayerMarketsSchema.parse(request.query);
      const source = sourceRegistry.get(fixture.source.provider);
      if (!source.listPlayerCandidates || !fixture.source.externalFixtureId) {
        return reply.code(400).send({
          error: `Provider ${fixture.source.provider} does not support player candidates for this fixture`
        });
      }

      const candidates = await source.listPlayerCandidates({
        externalFixtureId: fixture.source.externalFixtureId,
        limitPerTeam: input.limitPerTeam,
        cache: store
      });

      return { fixture, candidates };
    }
  );

  app.post<{ Params: { id: string } }>("/fixtures/:id/auto-main-card-player-markets", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const fixture = store.getFixture(request.params.id);
    if (!fixture) {
      return reply.code(404).send({ error: "Fixture not found" });
    }

    if (fixture.sport !== "football") {
      return reply.code(400).send({
        error: "Auto main-card player markets are currently only supported for football fixtures"
      });
    }

    const input = autoMainCardPlayerMarketsSchema.parse(request.body ?? {});
    const source = sourceRegistry.get(fixture.source.provider);
    if (!source.listPlayerCandidates || !fixture.source.externalFixtureId) {
      return reply.code(400).send({
        error: `Provider ${fixture.source.provider} does not support player candidates for this fixture`
      });
    }

    const candidates = await source.listPlayerCandidates({
      externalFixtureId: fixture.source.externalFixtureId,
      limitPerTeam: input.limitPerTeam,
      cache: store
    });
    const markets = candidates.map((candidate) =>
      createMainCardPlayerMarket({
        fixture: fixture as FootballFixture,
        playerId: candidate.player.playerId,
        playerName: candidate.player.playerName,
        teamSide: candidate.player.teamSide,
        template: "ANYTIME_GOALSCORER",
        status: input.status
      })
    );
    store.upsertMarkets(markets);

    return reply.code(201).send({
      fixture,
      candidates,
      markets,
      cards: buildMarketCards([fixture], store.listMarkets().filter((market) => market.fixtureId === fixture.id))
    });
  });

  app.post("/markets/player-futures", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const input = createPlayerTournamentFuturesSchema.parse(request.body ?? {});
    const marketsWithImages = await Promise.all(input.markets.map(async (market) => ({
      ...market,
      imageUrl: market.imageUrl ?? await lookupSportsDbPlayerImage(market.playerName)
    })));
    const markets = marketsWithImages.map((market) =>
      createPlayerTournamentFutureMarket({
        provider: input.provider,
        competition: input.competition,
        playerId: market.playerId,
        playerName: market.playerName,
        teamName: market.teamName,
        imageUrl: market.imageUrl,
        template: market.template,
        line: market.line,
        status: input.status
      })
    );
    store.upsertMarkets(markets);

    return reply.code(201).send({
      markets,
      cards: buildMarketSummaryCards(store, markets)
    });
  });

  app.post("/markets/yes-no", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const input = createYesNoMarketSchema.parse(request.body);
    const market = createYesNoMarket(input);
    store.upsertMarket(market);

    return reply.code(201).send(market);
  });

  app.get("/markets", async () => ({
    markets: store.listMarkets()
  }));

  app.get<{ Querystring: {
    q?: string | undefined;
    fixtureId?: string | undefined;
    sport?: string | undefined;
    status?: string | undefined;
    tradingStatus?: string | undefined;
    provider?: string | undefined;
    fixtureStatus?: string | undefined;
    marketType?: string | undefined;
    category?: string | undefined;
    competitionId?: string | undefined;
    competitionName?: string | undefined;
    sort?: string | undefined;
    direction?: string | undefined;
    offset?: string | undefined;
    limit?: string | undefined;
  } }>("/markets/summaries", async (request) => {
    const query = marketListQuerySchema.parse(request.query);
    const summaries = sortedMarketSummaries(store, filteredMarkets(store, query), query);
    const page = pageItems(summaries, query);
    return {
      summaries: page.items,
      pagination: page.pagination,
      sort: discoverySort(query)
    };
  });

  app.get<{ Querystring: {
    q?: string | undefined;
    fixtureId?: string | undefined;
    sport?: string | undefined;
    status?: string | undefined;
    tradingStatus?: string | undefined;
    provider?: string | undefined;
    fixtureStatus?: string | undefined;
    marketType?: string | undefined;
    category?: string | undefined;
    competitionId?: string | undefined;
    competitionName?: string | undefined;
    sort?: string | undefined;
    direction?: string | undefined;
    offset?: string | undefined;
    limit?: string | undefined;
  } }>("/markets/cards", async (request) => {
    const query = marketListQuerySchema.parse(request.query);
    const markets = filteredMarkets(store, query);
    const cards = sortedMarketSummaryCards(buildMarketSummaryCards(store, markets), query);
    const page = pageItems(cards, query);
    const checkedCards = query.tradingStatus === "open"
      ? page.items
      : await markCardsMissingCurrentFactoryMarkets(page.items);
    return {
      cards: filterCardsByRequestedTradingStatus(checkedCards, query.tradingStatus),
      pagination: page.pagination,
      sort: discoverySort(query)
    };
  });

  app.get<{ Params: { id: string } }>("/markets/:id", async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) {
      return reply.code(404).send({ error: "Market not found" });
    }

    return market;
  });

  app.post<{ Params: { id: string } }>("/markets/:id/create-on-chain", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) {
      return reply.code(404).send({ error: "Market not found" });
    }

    const input = createMarketOnChainSchema.parse(request.body ?? {});
    const result = await runTrackedOperatorTransaction(store, {
      action: "CREATE_MARKET",
      entityId: market.id,
      metadata: { marketId: market.id, marketType: market.type, source: "api" },
      execute: (onSubmitted) => createMarketOnChain({
        marketId: market.id,
        questionId: input.questionId as Hex | undefined,
        marketType: market.type,
        metadataURI: input.metadataURI ?? `market:${market.id}`,
        onSubmitted
      })
    });

    const updatedMarket: MarketDefinition = {
      ...market,
      conditionId: result.conditionId ?? market.conditionId
    };
    store.upsertMarket(updatedMarket);
    currentFactoryMarketCache.set(market.id, {
      checkedAt: Date.now(),
      conditionId: updatedMarket.conditionId
    });

    return reply.code(201).send({
      market: updatedMarket,
      onChain: result
    });
  });

  app.post<{ Params: { id: string } }>("/markets/:id/resolve", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) {
      return reply.code(404).send({ error: "Market not found" });
    }

    const result = providerFixtureResultSchema.parse(request.body);
    const fixtureMismatch = hasFixtureMismatch(market, result.fixtureId);
    if (fixtureMismatch) {
      return reply.code(400).send({
        error: `Source result fixture ${result.fixtureId} does not match market fixture ${market.fixtureId}`
      });
    }

    const decision = computeResolutionDecision(market, result);
    store.upsertResolution(decision);

    return reply.code(201).send(decision);
  });

  app.post<{ Params: { id: string } }>("/markets/:id/review-resolution", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) {
      return reply.code(404).send({ error: "Market not found" });
    }

    const decision = store.getResolution(market.id);
    if (!decision) {
      return reply.code(400).send({ error: "Compute the market resolution before reviewing it" });
    }
    if (decision.status !== "computed") {
      return reply.code(409).send({ error: "Only computed resolutions can be reviewed" });
    }

    const reviewedDecision = markResolutionReviewed(decision);
    store.upsertResolution(reviewedDecision);
    return reply.code(201).send(reviewedDecision);
  });

  app.post<{ Params: { id: string } }>("/markets/:id/submit-resolution", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) {
      return reply.code(404).send({ error: "Market not found" });
    }

    const decision = store.getResolution(market.id);
    if (!decision) {
      return reply.code(400).send({
        error: "Compute the market resolution before submitting it on-chain"
      });
    }

    const input = submitMarketResolutionOnChainSchema.parse(request.body ?? {});
    if (decision.outcome === "VOID") {
      return reply.code(400).send({
        error: "VOID resolutions require the void/refund resolver path before they can be submitted on-chain"
      });
    }
    if (decision.status !== "reviewed") {
      return reply.code(409).send({ error: "Resolution must be reviewed before submission" });
    }

    const questionId = (input.questionId ?? (await getMarketOnChain(market.id))?.questionId ?? hashIdentifier(market.id)) as Hex;
    const result = await submitResolutionOperatorTransaction(store, {
      marketId: market.id,
      outcome: decision.outcome,
      questionId,
      metadata: { marketId: market.id, outcome: decision.outcome, questionId, source: "api" }
    });
    const submittedDecision: ResolutionDecision = {
      ...decision,
      status: "submitted"
    };
    store.upsertResolution(submittedDecision);

    return reply.code(201).send({
      resolution: submittedDecision,
      onChain: result
    });
  });

  app.get("/resolutions", async () => ({
    resolutions: store.listResolutions()
  }));

  app.post("/clob/orders/prepare", {
    config: {
      rateLimit: {
        max: env.CLOB_ORDER_RATE_LIMIT_MAX,
        timeWindow: env.CLOB_ORDER_RATE_LIMIT_WINDOW
      }
    }
  }, async (request, reply) => {
    const input = prepareClobOrderSchema.parse(request.body);
    const market = store.getMarket(input.marketId);
    if (!market) return reply.code(404).send({ error: "Market not found" });
    if (!marketAcceptsOrders(market)) return reply.code(400).send({ error: marketTradingError(market) });

    const [prepared, readiness] = await Promise.all([
      prepareExchangeOrder({
        ...input,
        maker: input.maker as Address,
        signer: input.signer as Address | undefined,
        taker: input.taker as Address | undefined
      }),
      clobChain.getExchangeOrderReadiness({
        marketId: input.marketId,
        outcomeSide: input.outcomeSide,
        maker: input.maker as Address,
        side: input.side,
        makerAmount: input.makerAmount
      })
    ]);

    request.log.info({
      marketId: market.id,
      maker: input.maker,
      outcomeSide: input.outcomeSide,
      side: input.side,
      ip: request.ip
    }, "Prepared CLOB order signing payload");

    return reply.code(201).send({
      market,
      order: prepared.order,
      typedData: prepared.typedData,
      readiness
    });
  });

  app.post("/clob/orders/readiness", async (request, reply) => {
    const input = clobOrderReadinessSchema.parse(request.body);
    const market = store.getMarket(input.marketId);
    if (!market) return reply.code(404).send({ error: "Market not found" });
    if (!marketAcceptsOrders(market)) return reply.code(400).send({ error: marketTradingError(market) });

    return {
      market,
      readiness: await clobChain.getExchangeOrderReadiness({
        ...input,
        maker: input.maker as Address
      })
    };
  });

  app.post("/telegram/wallet", {
    preHandler: requireTelegramBotApiKey
  }, async (request, reply) => {
    const input = telegramUserSchema.parse(request.body);
    const wallet = await getOrCreatePrivyTelegramWallet(input);
    return reply.code(201).send({ wallet });
  });

  app.post("/telegram/export-link", {
    preHandler: requireTelegramBotApiKey
  }, async (request, reply) => {
    const input = telegramUserSchema.parse(request.body);
    const wallet = await getOrCreateExportablePrivyTelegramWallet(input);
    pruneExportTokens();
    const token = randomBytes(32).toString("base64url");
    exportTokens.set(token, {
      walletId: wallet.walletId,
      address: wallet.address,
      telegramUserId: input.telegramUserId,
      expiresAt: Date.now() + EXPORT_TOKEN_TTL_MS
    });

    return reply.code(201).send({
      wallet: {
        address: wallet.address
      },
      expiresInSeconds: Math.floor(EXPORT_TOKEN_TTL_MS / 1000),
      exportPath: `/wallet/export/${token}`
    });
  });

  app.get<{ Params: { token: string } }>("/wallet/export/:token", async (request, reply) => {
    const entry = getExportToken(request.params.token);
    if (!entry) return reply.type("text/html; charset=utf-8").code(404).send(exportPage("expired"));
    return reply
      .header("Cache-Control", "no-store")
      .type("text/html; charset=utf-8")
      .send(exportPage("ready", entry.address));
  });

  app.post<{ Params: { token: string } }>("/wallet/export/:token/reveal", async (request, reply) => {
    const entry = getExportToken(request.params.token);
    if (!entry) return reply.code(404).send({ error: "Export link expired or already used" });

    const privateKey = await exportPrivyWalletPrivateKey(entry.walletId);
    exportTokens.delete(request.params.token);
    request.log.warn({
      telegramUserId: entry.telegramUserId,
      wallet: entry.address
    }, "Exported Telegram Privy wallet private key");

    return reply
      .header("Cache-Control", "no-store")
      .code(200)
      .send({
        address: entry.address,
        privateKey
      });
  });

  app.post("/telegram/orders", {
    preHandler: requireTelegramBotApiKey,
    config: {
      rateLimit: {
        max: env.CLOB_ORDER_RATE_LIMIT_MAX,
        timeWindow: env.CLOB_ORDER_RATE_LIMIT_WINDOW
      }
    }
  }, async (request, reply) => {
    const input = telegramPlaceOrderSchema.parse(request.body);
    const market = store.getMarket(input.marketId);
    if (!market) return reply.code(404).send({ error: "Market not found" });
    if (!marketAcceptsOrders(market)) return reply.code(400).send({ error: marketTradingError(market) });

    const wallet = await getOrCreatePrivyTelegramWallet(input);
    let readiness = await clobChain.getExchangeOrderReadiness({
      marketId: input.marketId,
      outcomeSide: input.outcomeSide,
      maker: wallet.address,
      side: input.side,
      makerAmount: input.makerAmount
    });

    let approvalHash: Hex | undefined;
    if (!readiness.ready && readiness.asset.hasBalance && readiness.approval.transaction) {
      approvalHash = await sendPrivyTransaction(wallet.walletId, readiness.approval.transaction);
      const receipt = await createPublicChainClient().waitForTransactionReceipt({ hash: approvalHash });
      if (receipt.status !== "success") {
        return reply.code(400).send({ error: "Privy approval transaction failed", readiness, approvalHash });
      }
      readiness = await clobChain.getExchangeOrderReadiness({
        marketId: input.marketId,
        outcomeSide: input.outcomeSide,
        maker: wallet.address,
        side: input.side,
        makerAmount: input.makerAmount
      });
    }

    if (!readiness.ready) {
      return reply.code(400).send({
        error: "Privy wallet balance or exchange approval is not ready",
        wallet,
        readiness
      });
    }

    const prepared = await prepareExchangeOrder({
      marketId: input.marketId,
      outcomeSide: input.outcomeSide,
      maker: wallet.address,
      side: input.side,
      makerAmount: input.makerAmount,
      takerAmount: input.takerAmount,
      expiration: input.expiration,
      feeRateBps: input.feeRateBps,
      signatureType: 0
    });
    const signature = await signPrivyTypedData(wallet.walletId, prepared.typedData);
    const signedOrder: ExchangeOrder = {
      ...prepared.order,
      signature
    };
    const orderHash = await clobChain.validateExchangeOrder(signedOrder);
    const existing = store.getClobOrderByHash(orderHash);
    if (existing) return reply.code(200).send({ wallet, order: existing, readiness, approvalHash, duplicate: true });

    const now = new Date().toISOString();
    const order: StoredClobOrder = {
      id: randomUUID(),
      orderHash,
      marketId: market.id,
      outcomeSide: input.outcomeSide,
      order: signedOrder,
      side: signedOrder.side === 0 ? "BUY" : "SELL",
      remainingMaker: signedOrder.makerAmount,
      status: "open",
      createdAt: now,
      updatedAt: now
    };
    const stored = store.upsertClobOrder(order);

    let autoMatch;
    try {
      autoMatch = await autoMatchOrder(store, stored);
      if (!autoMatch.matched) {
        const houseMatch = await fillWithHouseLiquidity(store, store.getClobOrder(stored.id) ?? stored);
        if (houseMatch.attempted) autoMatch = houseMatch;
      }
    } catch (error) {
      request.log.warn({
        marketId: market.id,
        orderId: stored.id,
        error: error instanceof Error ? error.message : "Unknown matcher error"
      }, "Automatic CLOB matching failed after Telegram order acceptance");
      autoMatch = {
        attempted: true,
        matched: false,
        reason: error instanceof Error ? error.message : "Automatic matching failed"
      };
    }

    request.log.info({
      telegramUserId: input.telegramUserId,
      marketId: market.id,
      orderId: stored.id,
      orderHash,
      maker: wallet.address,
      outcomeSide: input.outcomeSide,
      side: input.side
    }, "Accepted Telegram Privy CLOB order");

    return reply.code(201).send({
      wallet,
      order: store.getClobOrder(stored.id) ?? stored,
      readiness,
      approvalHash,
      autoMatch
    });
  });

  app.post("/telegram/claims", {
    preHandler: requireTelegramBotApiKey
  }, async (request, reply) => {
    const input = telegramClaimWinningsSchema.parse(request.body);
    const market = store.getMarket(input.marketId);
    if (!market) return reply.code(404).send({ error: "Market not found" });

    const wallet = await getOrCreatePrivyTelegramWallet(input);
    const positions = await loadPortfolioPositions(store, clobChain, wallet.address, [market.id]);
    const position = positions.positions.find((item) => item.market.id === market.id);
    const redeemableOutcomes = position?.outcomes.filter((outcome) => outcome.redeemable) ?? [];
    if (!redeemableOutcomes.length) {
      return reply.code(400).send({
        error: "No redeemable winning position found for this market",
        wallet,
        position
      });
    }

    const tx = await clobChain.redemptionTransaction(market.id);
    const transactionHash = await sendPrivyTransaction(wallet.walletId, tx);
    const receipt = await createPublicChainClient().waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") {
      return reply.code(400).send({ error: "Claim transaction failed", wallet, market, transactionHash });
    }

    request.log.info({
      telegramUserId: input.telegramUserId,
      marketId: market.id,
      wallet: wallet.address,
      transactionHash
    }, "Claimed Telegram Privy winnings");

    return reply.code(201).send({
      wallet,
      market,
      transactionHash,
      redeemed: redeemableOutcomes.map((outcome) => ({
        side: outcome.outcome.side,
        balance: outcome.balance
      }))
    });
  });

  app.post("/telegram/withdrawals", {
    preHandler: requireTelegramBotApiKey
  }, async (request, reply) => {
    const input = telegramWithdrawalSchema.parse(request.body);
    const wallet = await getOrCreatePrivyTelegramWallet(input);
    const balances = await clobChain.getAccountPortfolioBalances(wallet.address, []);
    const balance = BigInt(balances.collateral.balance);
    const amount = BigInt(input.amount);
    if (amount > balance) {
      return reply.code(400).send({
        error: "Insufficient USDC balance",
        wallet,
        collateral: balances.collateral
      });
    }

    const tx = clobChain.collateralTransferTransaction(input.destination as Address, input.amount);
    const transactionHash = await sendPrivyTransaction(wallet.walletId, tx);
    const receipt = await createPublicChainClient().waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") {
      return reply.code(400).send({ error: "Withdrawal transaction failed", wallet, transactionHash });
    }

    request.log.info({
      telegramUserId: input.telegramUserId,
      wallet: wallet.address,
      destination: input.destination,
      amount: input.amount,
      transactionHash
    }, "Withdrew Telegram Privy USDC");

    return reply.code(201).send({
      wallet,
      destination: input.destination,
      amount: input.amount,
      transactionHash
    });
  });

  app.post("/clob/orders", {
    config: {
      rateLimit: {
        max: env.CLOB_ORDER_RATE_LIMIT_MAX,
        timeWindow: env.CLOB_ORDER_RATE_LIMIT_WINDOW
      }
    }
  }, async (request, reply) => {
    const input = submitClobOrderSchema.parse(request.body);
    const market = store.getMarket(input.marketId);
    if (!market) return reply.code(404).send({ error: "Market not found" });
    if (!marketAcceptsOrders(market)) return reply.code(400).send({ error: marketTradingError(market) });

    const storedMarket = await clobChain.getMarketOnChain(input.marketId);
    if (!storedMarket) return reply.code(400).send({ error: "Market has not been created on-chain" });

    const expectedTokenId =
      input.outcomeSide === "NO" || input.outcomeSide === "UNDER" ? storedMarket.token0 : storedMarket.token1;
    if (input.order.tokenId !== expectedTokenId) {
      return reply.code(400).send({ error: "Order tokenId does not match the requested market outcome" });
    }

    const readiness = await clobChain.getExchangeOrderReadiness({
      marketId: input.marketId,
      outcomeSide: input.outcomeSide,
      maker: input.order.maker as Address,
      side: input.order.side === 0 ? "BUY" : "SELL",
      makerAmount: input.order.makerAmount
    });
    if (!readiness.ready) {
      return reply.code(400).send({
        error: "Order maker balance or exchange approval is not ready",
        readiness
      });
    }

    const orderHash = await clobChain.validateExchangeOrder(input.order as ExchangeOrder);
    const existing = store.getClobOrderByHash(orderHash);
    if (existing) {
      request.log.info({
        marketId: market.id,
        orderId: existing.id,
        orderHash,
        maker: existing.order.maker,
        duplicate: true,
        ip: request.ip
      }, "Accepted duplicate CLOB order submission");
      return reply.code(200).send({ order: existing });
    }

    const now = new Date().toISOString();
    const order: StoredClobOrder = {
      id: randomUUID(),
      orderHash,
      marketId: market.id,
      outcomeSide: input.outcomeSide,
      order: input.order as ExchangeOrder,
      side: input.order.side === 0 ? "BUY" : "SELL",
      remainingMaker: input.order.makerAmount,
      status: "open",
      createdAt: now,
      updatedAt: now
    };

    const stored = store.upsertClobOrder(order);
    request.log.info({
      marketId: market.id,
      orderId: stored.id,
      orderHash: stored.orderHash,
      maker: stored.order.maker,
      outcomeSide: stored.outcomeSide,
      side: stored.side,
      ip: request.ip
    }, "Accepted signed CLOB order");

    let autoMatch;
    try {
      autoMatch = await autoMatchOrder(store, stored);
      if (!autoMatch.matched) {
        const houseMatch = await fillWithHouseLiquidity(store, store.getClobOrder(stored.id) ?? stored);
        if (houseMatch.attempted) autoMatch = houseMatch;
      }
      if (autoMatch.matched) {
        request.log.info({
          marketId: market.id,
          orderId: stored.id,
          tradeId: autoMatch.result?.trade.id,
          transactionHash: autoMatch.result?.trade.transactionHash
        }, "Automatically matched CLOB order");
      } else if (autoMatch.attempted) {
        request.log.info({
          marketId: market.id,
          orderId: stored.id,
          reason: autoMatch.reason
        }, "CLOB order left open after matching attempts");
      }
    } catch (error) {
      request.log.warn({
        marketId: market.id,
        orderId: stored.id,
        error: error instanceof Error ? error.message : "Unknown matcher error"
      }, "Automatic CLOB matching failed after order acceptance");
      autoMatch = {
        attempted: true,
        matched: false,
        reason: error instanceof Error ? error.message : "Automatic matching failed"
      };
    }

    return reply.code(201).send({
      order: store.getClobOrder(stored.id) ?? stored,
      readiness,
      autoMatch
    });
  });

  app.get<{ Querystring: { marketId?: string; maker?: string; status?: string } }>("/clob/orders", async (request) => {
    const orders = store.listClobOrders(request.query.marketId).filter((order) => {
      if (request.query.maker && order.order.maker.toLowerCase() !== request.query.maker.toLowerCase()) return false;
      if (request.query.status && order.status !== request.query.status) return false;
      return true;
    });
    return { orders };
  });

  app.get<{ Params: { id: string } }>("/clob/orders/:id", async (request, reply) => {
    const order = store.getClobOrder(request.params.id);
    if (!order) return reply.code(404).send({ error: "Order not found" });
    return { order, fills: store.listClobFills(order.id) };
  });

  app.get<{ Params: { maker: string } }>("/clob/nonces/:maker", async (request) => ({
    maker: request.params.maker,
    nonce: await getExchangeNonce(request.params.maker as Address)
  }));

  app.post("/clob/nonces/increment-transaction", async () => ({
    transaction: incrementNonceTransaction()
  }));

  app.post<{ Params: { id: string } }>("/clob/orders/:id/cancel-transaction", async (request, reply) => {
    const order = store.getClobOrder(request.params.id);
    if (!order) return reply.code(404).send({ error: "Order not found" });
    return {
      order,
      transaction: cancellationTransaction(order.order),
      note: "The maker wallet must send this transaction; CTFExchange only allows the order maker to cancel."
    };
  });

  app.post<{ Params: { id: string } }>("/clob/orders/:id/sync-status", async (request, reply) => {
    const order = store.getClobOrder(request.params.id);
    if (!order) return reply.code(404).send({ error: "Order not found" });

    const [nonce, onChain] = await Promise.all([
      getExchangeNonce(order.order.maker as Address),
      getExchangeOrderStatus(order.orderHash)
    ]);
    const updated = refreshStoredOrderStatus(order, nonce, onChain);
    store.upsertClobOrder(updated);

    return { order: updated, nonce, onChain };
  });

  app.post("/clob/matches", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const input = matchClobOrdersSchema.parse(request.body);
    const takerOrder = store.getClobOrder(input.takerOrderId);
    if (!takerOrder) return reply.code(404).send({ error: "Taker order not found" });
    const market = store.getMarket(takerOrder.marketId);
    if (!market) return reply.code(404).send({ error: "Market not found" });
    if (!marketAcceptsOrders(market)) return reply.code(400).send({ error: marketTradingError(market) });

    const makerOrders = input.makerOrderIds.map((id) => store.getClobOrder(id));
    if (makerOrders.some((order) => !order)) {
      return reply.code(404).send({ error: "Maker order not found" });
    }
    const definedMakerOrders = makerOrders as StoredClobOrder[];
    const plan = manualMatchPlan({
      takerOrder,
      makerOrders: definedMakerOrders,
      takerFillAmount: input.takerFillAmount,
      makerFillAmounts: input.makerFillAmounts
    });
    const orderError = matchRequestError(plan);
    if (orderError) return reply.code(400).send({ error: orderError });

    return reply.code(201).send(await executeMatchPlan(store, plan));
  });

  app.post("/clob/matcher/tick", {
    preHandler: requireClobOperatorApiKey
  }, async (request, reply) => {
    const input = tickClobMatcherSchema.parse(request.body ?? {});
    const summaries = await tickAutoMatcher(store, input);
    const remaining = input.limit - summaries.length;
    if (remaining > 0) {
      summaries.push(...await tickHouseLiquidity(store, { ...input, limit: remaining }));
    }
    const matched = summaries.filter((summary) => summary.matched).length;

    request.log.info({
      marketId: input.marketId,
      scanned: summaries.length,
      matched
    }, "Ran CLOB matcher tick");

    return reply.code(201).send({
      scanned: summaries.length,
      matched,
      summaries
    });
  });

  app.get<{ Params: { id: string } }>("/markets/:id/orderbook", async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) return reply.code(404).send({ error: "Market not found" });

    const orders = store.listClobOrders(market.id);

    return {
      market,
      orderbook: buildOrderbook(orders),
      priceData: marketPriceData(store, market.id, marketOutcomeSides(market))
    };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string | undefined } }>(
    "/markets/:id/trades",
    async (request, reply) => {
      const market = store.getMarket(request.params.id);
      if (!market) return reply.code(404).send({ error: "Market not found" });
      const query = marketTradesQuerySchema.parse(request.query);
      const ticks = marketTradeTicks(store, market.id).slice(0, query.limit);
      const tradeIds = new Set(ticks.map((tick) => tick.id));

      return {
        market,
        ticks,
        trades: store.listClobTrades(market.id).filter((trade) => tradeIds.has(trade.id)),
        fills: store.listClobFills().filter((fill) => {
          const order = store.getClobOrder(fill.orderId);
          return order?.marketId === market.id && tradeIds.has(fill.tradeId);
        })
      };
    }
  );

  app.get<{ Params: { id: string } }>("/markets/:id/price", async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) return reply.code(404).send({ error: "Market not found" });
    return { market, prices: marketPriceData(store, market.id, marketOutcomeSides(market)) };
  });

  app.get<{ Params: { id: string }; Querystring: { interval?: string | undefined; limit?: string | undefined } }>(
    "/markets/:id/chart",
    async (request, reply) => {
      const market = store.getMarket(request.params.id);
      if (!market) return reply.code(404).send({ error: "Market not found" });
      const query = marketChartQuerySchema.parse(request.query);
      const ticks = marketTradeTicks(store, market.id).slice(0, query.limit);

      return {
        market,
        interval: query.interval,
        candles: marketCandles(ticks, query.interval, marketOutcomeSides(market))
      };
    }
  );

  app.get<{ Params: { id: string } }>("/markets/:id/summary", async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) return reply.code(404).send({ error: "Market not found" });
    return buildMarketSummary(store, market);
  });

  app.post<{ Params: { id: string } }>("/markets/:id/redeem-transaction", async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) return reply.code(404).send({ error: "Market not found" });

    const resolution = store.getResolution(market.id);
    if (resolution?.status !== "submitted" || resolution.outcome === "VOID") {
      return reply.code(400).send({
        error: "Market does not have a submitted redeemable winning outcome"
      });
    }

    return {
      market,
      resolution,
      transaction: await clobChain.redemptionTransaction(market.id),
      note: "The position holder wallet sends this Conditional Tokens redemption transaction."
    };
  });

  app.get<{ Params: { account: string }; Querystring: { marketIds?: string | undefined } }>(
    "/portfolio/:account",
    async (request) => {
      const account = addressSchema.parse(request.params.account) as Address;
      const query = portfolioQuerySchema.parse(request.query);
      const activity = portfolioActivity(store, account);
      const positions = await loadPortfolioPositions(store, clobChain, account, query.marketIds);

      return {
        account,
        collateral: positions.collateral,
        positions: positions.positions,
        orders: activity.orders,
        trades: activity.trades,
        fills: activity.fills
      };
    }
  );

  app.get<{ Params: { account: string } }>("/portfolio/:account/orders", async (request) => {
    const account = addressSchema.parse(request.params.account) as Address;
    return { account, orders: portfolioActivity(store, account).orders };
  });

  app.get<{ Params: { account: string } }>("/portfolio/:account/trades", async (request) => {
    const account = addressSchema.parse(request.params.account) as Address;
    const activity = portfolioActivity(store, account);
    return { account, trades: activity.trades, fills: activity.fills };
  });

  app.get<{ Params: { account: string }; Querystring: { marketIds?: string | undefined } }>(
    "/portfolio/:account/positions",
    async (request) => {
      const account = addressSchema.parse(request.params.account) as Address;
      const query = portfolioQuerySchema.parse(request.query);
      const positions = await loadPortfolioPositions(store, clobChain, account, query.marketIds);
      return { account, collateral: positions.collateral, positions: positions.positions };
    }
  );
}

function writeMarketEvent(
  stream: NodeJS.WritableStream,
  event: { id: string; type: string; at: string }
): void {
  stream.write(`id: ${event.id}\n`);
  stream.write(`event: ${event.type}\n`);
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
}

function operatorTransactionStatus(status: string | undefined) {
  if (status === "attempted" || status === "pending" || status === "confirmed" || status === "failed") {
    return status;
  }
  return undefined;
}

function operatorTransactionAction(action: string | undefined) {
  if (action === "CREATE_MARKET" || action === "MATCH_ORDERS" || action === "SUBMIT_RESOLUTION") {
    return action;
  }
  return undefined;
}

function walletConnectionConfig() {
  const chain = xLayerChain();
  return {
    chain: {
      id: chain.id,
      hexId: hexChainId(chain.id),
      name: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: chain.rpcUrls.default.http
    },
    walletAddEthereumChain: {
      chainId: hexChainId(chain.id),
      chainName: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: chain.rpcUrls.default.http
    },
    contracts: {
      collateralToken: env.COLLATERAL_TOKEN_ADDRESS || undefined,
      conditionalTokens: env.CONDITIONAL_TOKENS_ADDRESS || undefined,
      ctfExchange: env.CTF_EXCHANGE_ADDRESS || undefined,
      marketFactory: env.MARKET_FACTORY_ADDRESS || undefined,
      binaryMarketResolver: env.BINARY_MARKET_RESOLVER_ADDRESS || undefined
    },
    clobOrderSigning: {
      domain: {
        ...exchangeDomain,
        chainId: chain.id,
        verifyingContract: env.CTF_EXCHANGE_ADDRESS || undefined
      },
      primaryType: "Order"
    },
    capabilities: {
      signClobOrders: Boolean(env.CTF_EXCHANGE_ADDRESS),
      buyApprovalTransactions: Boolean(env.COLLATERAL_TOKEN_ADDRESS && env.CTF_EXCHANGE_ADDRESS),
      sellApprovalTransactions: Boolean(env.CONDITIONAL_TOKENS_ADDRESS && env.CTF_EXCHANGE_ADDRESS),
      redemptionTransactions: Boolean(env.COLLATERAL_TOKEN_ADDRESS && env.CONDITIONAL_TOKENS_ADDRESS)
    }
  };
}

function hexChainId(chainId: number): Hex {
  return `0x${chainId.toString(16)}` as Hex;
}

function getExportToken(token: string) {
  pruneExportTokens();
  const entry = exportTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    exportTokens.delete(token);
    return undefined;
  }
  return entry;
}

function pruneExportTokens() {
  const now = Date.now();
  for (const [token, entry] of exportTokens) {
    if (entry.expiresAt < now) exportTokens.delete(token);
  }
}

function exportPage(state: "ready" | "expired", address = "") {
  if (state === "expired") {
    return htmlDocument("Export link expired", `
      <main>
        <h1>Export link expired</h1>
        <p>This export link is invalid, expired, or already used. Return to Telegram and request a new export link.</p>
      </main>
    `);
  }

  return htmlDocument("Export wallet private key", `
    <main>
      <h1>Export wallet private key</h1>
      <p class="address">${escapeHtml(address)}</p>
      <section class="warning">
        <strong>Anyone with this private key can control this wallet and move its funds.</strong>
        <span>Only continue if you are alone, on a trusted device, and ready to store the key safely.</span>
      </section>
      <label class="confirm">
        <input id="confirm" type="checkbox" />
        <span>I understand that Xsporty cannot recover funds if I share or lose this key.</span>
      </label>
      <button id="reveal" disabled>Reveal private key</button>
      <pre id="output" hidden></pre>
      <p id="status" role="status"></p>
    </main>
    <script>
      const confirmBox = document.getElementById("confirm");
      const reveal = document.getElementById("reveal");
      const output = document.getElementById("output");
      const status = document.getElementById("status");
      confirmBox.addEventListener("change", () => { reveal.disabled = !confirmBox.checked; });
      reveal.addEventListener("click", async () => {
        reveal.disabled = true;
        status.textContent = "Exporting...";
        try {
          const response = await fetch(location.pathname + "/reveal", { method: "POST" });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "Export failed");
          output.textContent = body.privateKey;
          output.hidden = false;
          status.textContent = "Private key shown once. Store it securely, then close this page.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Export failed";
          reveal.disabled = false;
        }
      });
    </script>
  `);
}

function htmlDocument(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #080a0f; color: #f6f7fb; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: min(100%, 620px); border: 1px solid #252b38; border-radius: 8px; padding: 24px; background: #10141d; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
    h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.2; }
    p { color: #bdc4d4; line-height: 1.5; }
    .address { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: #dbeafe; }
    .warning { display: grid; gap: 8px; margin: 20px 0; padding: 14px; border: 1px solid #7f1d1d; border-radius: 8px; background: #2a1114; color: #fecaca; line-height: 1.45; }
    .confirm { display: flex; gap: 10px; align-items: flex-start; margin: 18px 0; color: #e5e7eb; line-height: 1.45; }
    button { width: 100%; min-height: 44px; border: 0; border-radius: 6px; background: #e5e7eb; color: #111827; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    pre { margin-top: 18px; padding: 14px; border-radius: 6px; overflow-wrap: anywhere; white-space: pre-wrap; background: #06080d; color: #bbf7d0; border: 1px solid #1f2937; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function submitResolutionOperatorTransaction(
  store: InMemoryStore,
  input: {
    marketId: string;
    outcome: string;
    questionId: Hex;
    metadata: Record<string, unknown>;
  }
) {
  return runTrackedOperatorTransaction(store, {
    action: "SUBMIT_RESOLUTION",
    entityId: input.marketId,
    metadata: input.metadata,
    execute: (onSubmitted) => resolveMarketOnChain(
      input.questionId,
      outcomeSideToResolverOutcome(input.outcome),
      { onSubmitted }
    )
  });
}

function resolutionQuestionId(metadata: unknown): Hex | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const questionId = (metadata as { questionId?: unknown }).questionId;
  if (typeof questionId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(questionId)) return undefined;
  return questionId as Hex;
}

function hasFixtureMismatch(market: MarketDefinition, resultFixtureId: string): boolean {
  return Boolean(market.fixtureId && market.fixtureId !== resultFixtureId);
}

function currentDateWindow(days: number): string[] {
  const dates: string[] = [];
  const now = new Date();

  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    dates.push(date.toISOString().slice(0, 10));
  }

  return dates;
}

function rangeCurrentFixtureProvider(provider: string): boolean {
  return provider === "api-football" || provider === "pandascore";
}

async function loadFixtureInsights(
  fixtures: Fixture[],
  sourceRegistry: SourceRegistry,
  store: InMemoryStore
): Promise<Map<string, FixtureInsights>> {
  const entries = await Promise.all(
    fixtures.map(async (fixture) => {
      if (!fixture.source.externalFixtureId) return undefined;

      try {
        const insights = await loadProviderFixtureInsights({
          sourceRegistry,
          store,
          provider: fixture.source.provider,
          externalFixtureId: fixture.source.externalFixtureId,
          status: fixture.status
        });
        return [fixture.id, insights] as const;
      } catch {
        return undefined;
      }
    })
  );

  return new Map(entries.filter(isInsightEntry));
}

async function loadProviderFixtureInsights(input: {
  sourceRegistry: SourceRegistry;
  store: InMemoryStore;
  provider: string;
  externalFixtureId: string;
  status: FixtureStatus;
}): Promise<FixtureInsights> {
  const cacheKey = fixtureInsightsCacheKey(input.provider, input.externalFixtureId);
  const cached = input.store.getFixtureInsights(cacheKey);
  if (cached) return cached.insights;

  const source = input.sourceRegistry.get(input.provider);
  if (!source.getFixtureInsights) {
    throw new Error(`Provider ${input.provider} does not support fixture insights`);
  }

  const insights = await source.getFixtureInsights({
    externalFixtureId: input.externalFixtureId
  });
  input.store.upsertFixtureInsights(cacheKey, insights, fixtureInsightsTtlMs(input.status));

  return insights;
}

function fixtureInsightsCacheKey(provider: string, externalFixtureId: string): string {
  return `${provider}:${externalFixtureId}`;
}

function fixtureInsightsTtlMs(status: FixtureStatus): number {
  switch (status) {
    case "live":
      return env.FIXTURE_INSIGHTS_CACHE_LIVE_SECONDS * 1000;
    case "finished":
    case "cancelled":
    case "abandoned":
      return env.FIXTURE_INSIGHTS_CACHE_FINISHED_SECONDS * 1000;
    case "scheduled":
    case "postponed":
    default:
      return env.FIXTURE_INSIGHTS_CACHE_SCHEDULED_SECONDS * 1000;
  }
}

function isInsightEntry(
  entry: readonly [string, FixtureInsights] | undefined
): entry is readonly [string, FixtureInsights] {
  return Boolean(entry);
}

function buildMarketCards(
  fixtures: Fixture[],
  markets: MarketDefinition[],
  insightsByFixtureId = new Map<string, FixtureInsights>()
) {
  return fixtures.flatMap((fixture) => {
    const fixtureMarkets = markets.filter((market) => market.fixtureId === fixture.id);
    const mainMarkets = fixtureMarkets
      .filter((market) => market.template?.category !== "PLAYER")
      .filter((market) => isSupportedFixtureCardMarket(fixture, market));
    const playerMarkets = fixtureMarkets.filter((market) => market.template?.category === "PLAYER");

    return [
      {
        type: "MATCH",
        fixture,
        insights: insightsByFixtureId.get(fixture.id),
        markets: mainMarkets
      },
      ...playerMarkets.map((market) => ({
        type: "PLAYER",
        fixture,
        playerName: market.template?.category === "PLAYER" ? market.template.player.playerName : undefined,
        player: market.template?.category === "PLAYER" ? market.template.player : undefined,
        markets: [market]
      }))
    ];
  });
}

function buildMarketSummaryCards(store: InMemoryStore, markets: MarketDefinition[]) {
  const fixtureMarkets = markets.filter((market) => market.fixtureId && store.getFixture(market.fixtureId));
  const fixtureIds = new Set(fixtureMarkets.map((market) => market.fixtureId));
  const fixtures = store.listFixtures().filter((fixture) => fixtureIds.has(fixture.id));
  const fixtureCards = fixtures.flatMap((fixture) => {
    const summaries = fixtureMarkets
      .filter((market) => market.fixtureId === fixture.id)
      .filter((market) => isSupportedFixtureCardMarket(fixture, market))
      .map((market) => buildMarketSummary(store, market));
    const mainMarkets = summaries.filter((summary) => summary.market.template?.category !== "PLAYER");
    const playerMarkets = summaries.filter((summary) => summary.market.template?.category === "PLAYER");

    return [
      ...(mainMarkets.length > 0 ? [{
        type: "MATCH",
        fixture,
        summaries: mainMarkets
      }] : []),
      ...playerMarkets.map((summary) => ({
        type: "PLAYER",
        fixture,
        playerName: summary.market.template?.category === "PLAYER"
          ? summary.market.template.player.playerName
          : undefined,
        player: summary.market.template?.category === "PLAYER"
          ? summary.market.template.player
          : undefined,
        summaries: [summary]
      }))
    ];
  });
  const fixtureCardIds = new Set(fixtureMarkets.map((market) => market.id));
  const playerFutureCards = markets
    .filter((market) => market.template?.category === "PLAYER_FUTURE")
    .map((market) => ({
      type: "PLAYER_FUTURE",
      playerName: market.template?.category === "PLAYER_FUTURE"
        ? market.template.player.playerName
        : undefined,
      player: market.template?.category === "PLAYER_FUTURE"
        ? market.template.player
        : undefined,
      competition: market.template?.category === "PLAYER_FUTURE"
        ? market.template.competition
        : undefined,
      summaries: [buildMarketSummary(store, market)]
    }));
  const standaloneCards = markets
    .filter((market) => !fixtureCardIds.has(market.id) && market.template?.category !== "PLAYER_FUTURE")
    .map((market) => ({
      type: "MARKET",
      summaries: [buildMarketSummary(store, market)]
    }));

  return [...fixtureCards, ...playerFutureCards, ...standaloneCards];
}

const currentFactoryMarketCache = new Map<string, { checkedAt: number; conditionId?: string | undefined }>();
const CURRENT_FACTORY_MARKET_CACHE_MS = 5 * 60_000;
const MARKET_SYNCING_REASON = "Market syncing on-chain";

async function markCardsMissingCurrentFactoryMarkets<T extends Array<Record<string, unknown>>>(cards: T): Promise<T> {
  const markets = cards.flatMap((card) =>
    Array.isArray(card.summaries)
      ? card.summaries
        .map((summary) => summary && typeof summary === "object" && "market" in summary
          ? (summary as { market?: MarketDefinition }).market
          : undefined)
        .filter((market): market is MarketDefinition => Boolean(market))
      : []
  );
  const uniqueOpenMarkets = [...new Map(
    markets
      .filter((market) => market.status === "open")
      .filter((market) => market.tradingStatusReason === MARKET_SYNCING_REASON)
      .map((market) => [market.id, market])
  ).values()];

  const conditionIds = new Map<string, string | undefined>();
  await mapWithConcurrency(uniqueOpenMarkets, env.MARKET_CARD_RPC_CONCURRENCY, async (market) => {
    conditionIds.set(market.id, await currentFactoryConditionId(market.id));
  });

  return cards.map((card) => {
    if (!Array.isArray(card.summaries)) return card;
    const summaries = card.summaries.map((summary) => {
      if (!summary || typeof summary !== "object" || !("market" in summary)) return summary;
      const market = (summary as { market?: MarketDefinition }).market;
      if (!market || market.status !== "open") return summary;
      if (!conditionIds.has(market.id)) return summary;
      const currentConditionId = conditionIds.get(market.id);
      if (currentConditionId) {
        return {
          ...summary,
          market: {
            ...market,
            conditionId: currentConditionId,
            ...(market.tradingStatusReason === MARKET_SYNCING_REASON ? { tradingStatusReason: undefined } : {})
          }
        };
      }
      return {
        ...summary,
        market: {
          ...market,
          conditionId: undefined,
          tradingStatus: "suspended",
          tradingStatusReason: MARKET_SYNCING_REASON,
          tradingStatusUpdatedAt: new Date().toISOString()
        }
      };
    });
    return { ...card, summaries };
  }) as T;
}

function filterCardsByRequestedTradingStatus<T extends Array<Record<string, unknown>>>(
  cards: T,
  tradingStatus: MarketDefinition["tradingStatus"] | undefined
): T {
  if (!tradingStatus) return cards;

  return cards
    .map((card) => {
      if (!Array.isArray(card.summaries)) return card;
      const summaries = card.summaries.filter((summary) => {
        if (!summary || typeof summary !== "object" || !("market" in summary)) return false;
        const market = (summary as { market?: MarketDefinition }).market;
        if (tradingStatus === "open" && !market?.conditionId) return false;
        if (tradingStatus === "open" && market?.tradingStatusReason === MARKET_SYNCING_REASON) return false;
        return market?.tradingStatus === tradingStatus;
      });
      return { ...card, summaries };
    })
    .filter((card) => !Array.isArray(card.summaries) || card.summaries.length > 0) as T;
}

async function currentFactoryConditionId(marketId: string): Promise<string | undefined> {
  const cached = currentFactoryMarketCache.get(marketId);
  if (cached && Date.now() - cached.checkedAt < CURRENT_FACTORY_MARKET_CACHE_MS) {
    return cached.conditionId;
  }

  try {
    const stored = await getMarketOnChain(marketId);
    if (stored && env.COLLATERAL_TOKEN_ADDRESS && env.CONDITIONAL_TOKENS_ADDRESS) {
      const usesCurrentCollateral = await marketUsesCurrentCollateral(
        createPublicChainClient(),
        requireAddress(env.CONDITIONAL_TOKENS_ADDRESS, "CONDITIONAL_TOKENS_ADDRESS"),
        requireAddress(env.COLLATERAL_TOKEN_ADDRESS, "COLLATERAL_TOKEN_ADDRESS"),
        stored
      );
      if (!usesCurrentCollateral) {
        currentFactoryMarketCache.set(marketId, {
          checkedAt: Date.now(),
          conditionId: undefined
        });
        return undefined;
      }
    }
    currentFactoryMarketCache.set(marketId, {
      checkedAt: Date.now(),
      conditionId: stored?.conditionId
    });
    return stored?.conditionId;
  } catch {
    currentFactoryMarketCache.set(marketId, {
      checkedAt: Date.now(),
      conditionId: undefined
    });
    return undefined;
  }
}

async function lookupSportsDbPlayerImage(playerName: string): Promise<string | undefined> {
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/123/searchplayers.php?p=${encodeURIComponent(playerName)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return undefined;
    const body = await response.json() as {
      player?: Array<{
        strPlayer?: string | null;
        strCutout?: string | null;
        strThumb?: string | null;
        strRender?: string | null;
      }> | null;
    };
    const players = body.player ?? [];
    const exactMatch = players.find((player) => player.strPlayer?.toLowerCase() === playerName.toLowerCase());
    const player = exactMatch ?? players[0];
    return player?.strCutout ?? player?.strThumb ?? player?.strRender ?? undefined;
  } catch {
    return undefined;
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) await mapper(item);
    }
  });
  await Promise.all(workers);
}

function isSupportedFixtureCardMarket(fixture: Fixture, market: MarketDefinition): boolean {
  if (fixture.sport !== "football" || fixture.competition?.name !== "Friendlies") return true;
  if (market.type === "TOTAL_GOALS" || market.type === "BOTH_TEAMS_TO_SCORE") return true;
  return market.resolver?.rule === "HOME_TEAM_WIN"
    || market.resolver?.rule === "DRAW"
    || market.resolver?.rule === "AWAY_TEAM_WIN";
}

function refreshStoredOrderStatus(
  order: StoredClobOrder,
  currentNonce: string,
  onChain: { isFilledOrCancelled: boolean; remaining: string }
): StoredClobOrder {
  if (order.status === "filled" || order.status === "cancelled") return order;

  if (currentNonce !== order.order.nonce) {
    return { ...order, status: "cancelled", updatedAt: new Date().toISOString() };
  }

  if (onChain.isFilledOrCancelled) {
    return {
      ...order,
      remainingMaker: onChain.remaining,
      status: onChain.remaining === "0" ? "cancelled" : "partially_filled",
      updatedAt: new Date().toISOString()
    };
  }

  if (onChain.remaining !== "0") {
    return {
      ...order,
      remainingMaker: onChain.remaining,
      status: onChain.remaining === order.order.makerAmount ? "open" : "partially_filled",
      updatedAt: new Date().toISOString()
    };
  }

  return order;
}

async function loadPortfolioPositions(
  store: InMemoryStore,
  clobChain: ClobRouteChain,
  account: Address,
  marketIds?: string[] | undefined
) {
  const markets = portfolioMarketCandidates(store, account, marketIds);
  const balances = await clobChain.getAccountPortfolioBalances(account, markets);
  const byMarketId = new Map(balances.markets.map((market) => [market.marketId, market]));
  const positions = markets.flatMap((market) => {
    const balance = byMarketId.get(market.id);
    if (!balance) return [];

    return [
      enrichPortfolioPosition({
        store,
        account,
        market,
        token0: balance.token0,
        token1: balance.token1,
        balance0: balance.balance0,
        balance1: balance.balance1,
        resolution: store.getResolution(market.id)
      })
    ];
  });

  return { collateral: balances.collateral, positions };
}

function marketOutcomeSides(market: MarketDefinition) {
  return market.outcomes.map((outcome) => outcome.side);
}

function buildMarketSummary(store: InMemoryStore, market: MarketDefinition) {
  return {
    market,
    fixture: market.fixtureId ? store.getFixture(market.fixtureId) : undefined,
    resolution: store.getResolution(market.id),
    summary: marketSummaryData(store, market.id, marketOutcomeSides(market))
  };
}

function filteredMarkets(
  store: InMemoryStore,
  query: {
    q?: string | undefined;
    fixtureId?: string | undefined;
    sport?: Fixture["sport"] | undefined;
    status?: MarketDefinition["status"] | undefined;
    tradingStatus?: MarketDefinition["tradingStatus"] | undefined;
    provider?: string | undefined;
    fixtureStatus?: FixtureStatus | undefined;
    marketType?: MarketDefinition["type"] | undefined;
    category?: "match" | "player" | "main_player" | "player_future" | "standalone" | undefined;
    competitionId?: string | undefined;
    competitionName?: string | undefined;
  }
) {
  const now = Date.now();
  return store.listMarkets()
    .filter((market) => !query.fixtureId || market.fixtureId === query.fixtureId)
    .filter((market) => !query.status || market.status === query.status)
    .filter((market) => !query.tradingStatus || market.tradingStatus === query.tradingStatus)
    .filter((market) =>
      query.tradingStatus !== "open" || (Boolean(market.conditionId) && market.tradingStatusReason !== MARKET_SYNCING_REASON)
    )
    .filter((market) => !query.marketType || market.type === query.marketType)
    .filter((market) => !query.category || discoveryCategory(market) === query.category)
    .filter((market) => {
      if (!query.provider) return true;
      return discoveryProvider(store, market)?.toLowerCase() === query.provider.toLowerCase();
    })
    .filter((market) => {
      if (!query.sport) return true;
      if (market.template?.category === "PLAYER_FUTURE") return query.sport === "football";
      if (!market.fixtureId) return false;
      return store.getFixture(market.fixtureId)?.sport === query.sport;
    })
    .filter((market) => {
      if (!query.fixtureStatus) return true;
      if (!market.fixtureId) return false;
      return store.getFixture(market.fixtureId)?.status === query.fixtureStatus;
    })
    .filter((market) => market.status !== "open" || isCurrentOpenFixtureMarket(store, market, now))
    .filter((market) => {
      if (!query.competitionId) return true;
      if (market.template?.category === "PLAYER_FUTURE") {
        return market.template.competition.id?.toLowerCase() === query.competitionId.toLowerCase();
      }
      if (!market.fixtureId) return false;
      return store.getFixture(market.fixtureId)?.competition?.id?.toLowerCase() === query.competitionId.toLowerCase();
    })
    .filter((market) => {
      if (!query.competitionName) return true;
      if (market.template?.category === "PLAYER_FUTURE") {
        return market.template.competition.name.toLowerCase().includes(query.competitionName.toLowerCase());
      }
      if (!market.fixtureId) return false;
      return store.getFixture(market.fixtureId)?.competition?.name.toLowerCase()
        .includes(query.competitionName.toLowerCase()) ?? false;
    })
    .filter((market) => !query.q || matchesDiscoverySearch(store, market, query.q));
}

const STALE_SCHEDULED_FIXTURE_GRACE_MS = 2 * 60 * 60 * 1000;
const STALE_LIVE_FIXTURE_GRACE_MS = 24 * 60 * 60 * 1000;
const STALE_ESPORTS_LIVE_FIXTURE_GRACE_MS = 4 * 60 * 60 * 1000;

function isCurrentOpenFixtureMarket(store: InMemoryStore, market: MarketDefinition, now: number): boolean {
  if (!market.fixtureId || market.template?.category === "PLAYER_FUTURE") return true;
  const fixture = store.getFixture(market.fixtureId);
  if (!fixture) return false;
  const kickoffTime = Date.parse(fixture.kickoffTime);
  if (!Number.isFinite(kickoffTime)) return false;
  if (fixture.status === "scheduled") return kickoffTime >= now - STALE_SCHEDULED_FIXTURE_GRACE_MS;
  if (fixture.status === "live") {
    const grace = fixture.sport === "esports"
      ? STALE_ESPORTS_LIVE_FIXTURE_GRACE_MS
      : STALE_LIVE_FIXTURE_GRACE_MS;
    return kickoffTime >= now - grace;
  }
  return false;
}

type MarketDiscoverySort = {
  sort: "kickoff_time" | "live_status" | "volume" | "newest_activity";
  direction: "asc" | "desc";
};

type MarketDiscoveryQuery = {
  sort: MarketDiscoverySort["sort"];
  direction?: MarketDiscoverySort["direction"] | undefined;
  offset: number;
  limit: number;
};

type MarketSummaryPayload = ReturnType<typeof buildMarketSummary>;

function sortedMarketSummaries(
  store: InMemoryStore,
  markets: MarketDefinition[],
  query: MarketDiscoveryQuery
) {
  const sort = discoverySort(query);
  return markets
    .map((market) => buildMarketSummary(store, market))
    .sort((left, right) => compareDiscoverySummaries(left, right, sort));
}

function sortedMarketSummaryCards<T extends {
  type: string;
  fixture?: Fixture | undefined;
  summaries: MarketSummaryPayload[];
}>(cards: T[], query: MarketDiscoveryQuery) {
  const sort = discoverySort(query);
  return cards.sort((left, right) => compareDiscoveryCards(left, right, sort));
}

function discoverySort(query: Pick<MarketDiscoveryQuery, "sort" | "direction">): MarketDiscoverySort {
  return {
    sort: query.sort,
    direction: query.direction ?? (query.sort === "kickoff_time" ? "asc" : "desc")
  };
}

function compareDiscoverySummaries(
  left: MarketSummaryPayload,
  right: MarketSummaryPayload,
  sort: MarketDiscoverySort
): number {
  switch (sort.sort) {
    case "kickoff_time":
      return compareKickoff(left.fixture, right.fixture, sort.direction)
        || compareMarketIds(left.market.id, right.market.id);
    case "live_status":
      return compareNumbers(liveRank(left.fixture), liveRank(right.fixture), sort.direction)
        || compareKickoff(left.fixture, right.fixture, "asc")
        || compareMarketIds(left.market.id, right.market.id);
    case "volume":
      return compareBigInts(BigInt(left.summary.volume), BigInt(right.summary.volume), sort.direction)
        || compareKickoff(left.fixture, right.fixture, "asc")
        || compareMarketIds(left.market.id, right.market.id);
    case "newest_activity":
      return compareNumbers(activityTime(left.summary.latestActivityAt), activityTime(right.summary.latestActivityAt), sort.direction)
        || compareKickoff(left.fixture, right.fixture, "asc")
        || compareMarketIds(left.market.id, right.market.id);
  }
}

function compareDiscoveryCards(
  left: { type: string; fixture?: Fixture | undefined; summaries: MarketSummaryPayload[] },
  right: { type: string; fixture?: Fixture | undefined; summaries: MarketSummaryPayload[] },
  sort: MarketDiscoverySort
): number {
  switch (sort.sort) {
    case "kickoff_time":
      return compareKickoff(cardFixture(left), cardFixture(right), sort.direction)
        || compareMarketIds(cardStableId(left), cardStableId(right));
    case "live_status":
      return compareNumbers(liveRank(cardFixture(left)), liveRank(cardFixture(right)), sort.direction)
        || compareKickoff(cardFixture(left), cardFixture(right), "asc")
        || compareMarketIds(cardStableId(left), cardStableId(right));
    case "volume":
      return compareBigInts(cardVolume(left), cardVolume(right), sort.direction)
        || compareKickoff(cardFixture(left), cardFixture(right), "asc")
        || compareMarketIds(cardStableId(left), cardStableId(right));
    case "newest_activity":
      return compareNumbers(cardActivityTime(left), cardActivityTime(right), sort.direction)
        || compareKickoff(cardFixture(left), cardFixture(right), "asc")
        || compareMarketIds(cardStableId(left), cardStableId(right));
  }
}

function pageItems<T>(items: T[], query: Pick<MarketDiscoveryQuery, "offset" | "limit">) {
  const end = query.offset + query.limit;
  return {
    items: items.slice(query.offset, end),
    pagination: {
      offset: query.offset,
      limit: query.limit,
      total: items.length,
      hasMore: end < items.length,
      nextOffset: end < items.length ? end : undefined
    }
  };
}

function compareKickoff(
  left?: Fixture,
  right?: Fixture,
  direction: MarketDiscoverySort["direction"] = "asc"
): number {
  const leftTime = left ? Date.parse(left.kickoffTime) : undefined;
  const rightTime = right ? Date.parse(right.kickoffTime) : undefined;
  if (leftTime === undefined && rightTime === undefined) return 0;
  if (leftTime === undefined) return 1;
  if (rightTime === undefined) return -1;
  return compareNumbers(leftTime, rightTime, direction);
}

function compareNumbers(left: number, right: number, direction: MarketDiscoverySort["direction"]): number {
  if (left === right) return 0;
  return direction === "asc"
    ? left < right ? -1 : 1
    : left > right ? -1 : 1;
}

function compareBigInts(left: bigint, right: bigint, direction: MarketDiscoverySort["direction"]): number {
  if (left === right) return 0;
  return direction === "asc"
    ? left < right ? -1 : 1
    : left > right ? -1 : 1;
}

function compareMarketIds(left: string, right: string): number {
  return left.localeCompare(right);
}

function liveRank(fixture?: Fixture): number {
  return fixture?.status === "live" ? 1 : 0;
}

function activityTime(value?: string): number {
  return value ? Date.parse(value) : 0;
}

function cardFixture(card: { fixture?: Fixture | undefined; summaries: MarketSummaryPayload[] }) {
  return card.fixture ?? card.summaries[0]?.fixture;
}

function cardStableId(card: { type: string; summaries: MarketSummaryPayload[] }) {
  return `${card.type}:${card.summaries.map((summary) => summary.market.id).join(",")}`;
}

function cardVolume(card: { summaries: MarketSummaryPayload[] }): bigint {
  return card.summaries.reduce((total, summary) => total + BigInt(summary.summary.volume), 0n);
}

function cardActivityTime(card: { summaries: MarketSummaryPayload[] }): number {
  return card.summaries.reduce(
    (latest, summary) => Math.max(latest, activityTime(summary.summary.latestActivityAt)),
    0
  );
}

function discoveryProvider(store: InMemoryStore, market: MarketDefinition): string | undefined {
  return market.source?.provider
    ?? market.resolver?.source.provider
    ?? (market.fixtureId ? store.getFixture(market.fixtureId)?.source.provider : undefined);
}

function discoveryCategory(market: MarketDefinition) {
  if (market.template?.category === "PLAYER") return "player";
  if (market.template?.category === "MAIN_PLAYER") return "main_player";
  if (market.template?.category === "PLAYER_FUTURE") return "player_future";
  if (!market.fixtureId) return "standalone";
  return "match";
}

function matchesDiscoverySearch(store: InMemoryStore, market: MarketDefinition, query: string): boolean {
  const fixture = market.fixtureId ? store.getFixture(market.fixtureId) : undefined;
  const player = market.template?.category === "PLAYER" || market.template?.category === "MAIN_PLAYER" || market.template?.category === "PLAYER_FUTURE"
    ? market.template.player
    : undefined;
  const futureCompetition = market.template?.category === "PLAYER_FUTURE"
    ? market.template.competition
    : undefined;
  const terms = [
    market.id,
    market.title,
    market.type,
    market.status,
    market.tradingStatus,
    market.tradingStatusReason,
    market.source?.provider,
    market.resolver?.source.provider,
    market.resolver?.rule,
    market.outcomes.map((outcome) => outcome.label).join(" "),
    fixture?.id,
    fixture?.source.provider,
    fixture?.homeCompetitor,
    fixture?.awayCompetitor,
    fixture?.competition?.id,
    fixture?.competition?.name,
    fixture?.competition?.season,
    fixture?.competition?.kind,
    futureCompetition?.id,
    futureCompetition?.name,
    futureCompetition?.season,
    futureCompetition?.kind,
    fixture && "gameTitle" in fixture ? fixture.gameTitle : undefined,
    fixture && "tournamentName" in fixture ? fixture.tournamentName : undefined,
    player?.playerId,
    player?.playerName,
    player?.teamName
  ];
  const needle = query.toLowerCase();

  return terms
    .filter((term): term is string => typeof term === "string")
    .some((term) => term.toLowerCase().includes(needle));
}

function marketAcceptsOrders(market: MarketDefinition): boolean {
  return market.status === "open" && market.tradingStatus === "open";
}

function marketTradingError(market: MarketDefinition): string {
  if (market.status !== "open") return "Only open markets accept orders";
  return market.tradingStatusReason
    ? `Market trading is ${market.tradingStatus}: ${market.tradingStatusReason}`
    : `Market trading is ${market.tradingStatus}`;
}
