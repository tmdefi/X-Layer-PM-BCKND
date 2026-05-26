import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import {
  cancellationTransaction,
  createMarketOnChain,
  getExchangeNonce,
  getExchangeOrderStatus,
  getExchangeOrderReadiness,
  getAccountPortfolioBalances,
  getMarketOnChain,
  hashIdentifier,
  incrementNonceTransaction,
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
import { requireClobOperatorApiKey } from "./security.js";
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
  tickClobMatcherSchema
} from "./schemas.js";

export type ClobRouteChain = {
  getMarketOnChain: typeof getMarketOnChain;
  getExchangeOrderReadiness: typeof getExchangeOrderReadiness;
  validateExchangeOrder: typeof validateExchangeOrder;
  getAccountPortfolioBalances: typeof getAccountPortfolioBalances;
  redemptionTransaction: typeof redemptionTransaction;
};

const defaultClobRouteChain: ClobRouteChain = {
  getMarketOnChain,
  getExchangeOrderReadiness,
  validateExchangeOrder,
  getAccountPortfolioBalances,
  redemptionTransaction
};

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
      requiresLine
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
    const markets = input.markets.map((market) =>
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
    return {
      cards: await markCardsMissingCurrentFactoryMarkets(page.items),
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

    const questionId = (input.questionId ?? hashIdentifier(market.id)) as Hex;
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
      .map((market) => [market.id, market])
  ).values()];

  const conditionIds = new Map<string, string | undefined>();
  await mapWithConcurrency(uniqueOpenMarkets, 12, async (market) => {
    conditionIds.set(market.id, await currentFactoryConditionId(market.id));
  });

  return cards.map((card) => {
    if (!Array.isArray(card.summaries)) return card;
    const summaries = card.summaries.map((summary) => {
      if (!summary || typeof summary !== "object" || !("market" in summary)) return summary;
      const market = (summary as { market?: MarketDefinition }).market;
      if (!market || market.status !== "open") return summary;
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

async function currentFactoryConditionId(marketId: string): Promise<string | undefined> {
  const cached = currentFactoryMarketCache.get(marketId);
  if (cached && Date.now() - cached.checkedAt < CURRENT_FACTORY_MARKET_CACHE_MS) {
    return cached.conditionId;
  }

  try {
    const stored = await getMarketOnChain(marketId);
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

function isCurrentOpenFixtureMarket(store: InMemoryStore, market: MarketDefinition, now: number): boolean {
  if (!market.fixtureId || market.template?.category === "PLAYER_FUTURE") return true;
  const fixture = store.getFixture(market.fixtureId);
  if (!fixture) return false;
  const kickoffTime = Date.parse(fixture.kickoffTime);
  if (!Number.isFinite(kickoffTime)) return false;
  if (fixture.status === "scheduled") return kickoffTime >= now - STALE_SCHEDULED_FIXTURE_GRACE_MS;
  if (fixture.status === "live") return kickoffTime >= now - STALE_LIVE_FIXTURE_GRACE_MS;
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
