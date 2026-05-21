import type { FastifyInstance } from "fastify";
import type { Hex } from "viem";
import { createMarketOnChain, hashIdentifier, outcomeSideToResolverOutcome, resolveMarketOnChain } from "../chain/index.js";
import { env } from "../config/env.js";
import {
  MAIN_CARD_PLAYER_MARKET_TEMPLATES,
  PLAYER_MARKET_TEMPLATES,
  createBasketballFixtureMarkets,
  createFootballFixtureMarkets,
  createMainCardPlayerMarket,
  createPlayerMarket,
  createYesNoMarket
} from "../markets/definitions.js";
import { computeResolutionDecision } from "../markets/resolution.js";
import type {
  BasketballFixture,
  Fixture,
  FixtureStatus,
  FootballFixture,
  MarketDefinition,
  ResolutionDecision
} from "../markets/types.js";
import type { FixtureInsights, FixtureQuery, SourceRegistry } from "../sources/index.js";
import type { SettlementWorker } from "../settlement/index.js";
import type { ProviderSyncWorker } from "../sync/index.js";
import type { InMemoryStore } from "./store.js";
import {
  autoMainCardPlayerMarketsSchema,
  createMarketOnChainSchema,
  createMainCardPlayerMarketsSchema,
  createPlayerMarketsSchema,
  currentFixtureQuerySchema,
  createYesNoMarketSchema,
  fixtureSchema,
  generateFixtureMarketsSchema,
  providerFixtureResultSchema,
  sourceFixtureQuerySchema,
  submitMarketResolutionOnChainSchema
} from "./schemas.js";

export async function registerRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
  sourceRegistry: SourceRegistry,
  settlementWorker?: SettlementWorker,
  syncWorker?: ProviderSyncWorker
): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    service: "prediction-market-backend"
  }));

  app.get("/sports", async () => ({
    sports: ["football", "basketball", "american_football", "esports"]
  }));

  app.get("/market-templates/player", async () => ({
    templates: PLAYER_MARKET_TEMPLATES.map(({ template, label }) => ({ template, label }))
  }));

  app.get("/market-templates/main-card-player", async () => ({
    templates: MAIN_CARD_PLAYER_MARKET_TEMPLATES.map(({ template, label }) => ({ template, label }))
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

  app.get<{ Querystring: { limit?: string | undefined } }>("/sync/logs", async (request) => ({
    logs: store.listProviderSyncLogs(Number(request.query.limit ?? 50))
  }));

  app.post<{ Params: { provider: string } }>("/sync/:provider/current", async (request, reply) => {
    if (!syncWorker) {
      return reply.code(503).send({ error: "Provider sync worker is not configured" });
    }

    const summary = await syncWorker.runOnce(request.params.provider);
    return reply.code(201).send({ summary });
  });

  app.post("/sync/current", async (_request, reply) => {
    if (!syncWorker) {
      return reply.code(503).send({ error: "Provider sync worker is not configured" });
    }

    const summary = await syncWorker.runOnce();
    return reply.code(201).send({ summary });
  });

  app.post("/settlement/tick", async (request, reply) => {
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
      const sport = query.sport ?? (request.params.provider === "api-football" ? "football" : undefined);
      const fixtures = (
        await Promise.all(
          currentDateWindow(query.days).map((date) => {
            const sourceQuery: FixtureQuery = { from: date };
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

  app.post("/fixtures", async (request, reply) => {
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

  app.post<{ Params: { id: string } }>("/fixtures/:id/markets", async (request, reply) => {
    const fixture = store.getFixture(request.params.id);
    if (!fixture) {
      return reply.code(404).send({ error: "Fixture not found" });
    }

    if (fixture.sport !== "football" && fixture.sport !== "basketball") {
      return reply.code(400).send({
        error: "Generated structured markets are currently only supported for football and basketball fixtures"
      });
    }

    const options = generateFixtureMarketsSchema.parse(request.body ?? {});
    const markets =
      fixture.sport === "football"
        ? createFootballFixtureMarkets(fixture as FootballFixture, options)
        : createBasketballFixtureMarkets(fixture as BasketballFixture, options);
    store.upsertMarkets(markets);

    return reply.code(201).send({ markets });
  });

  app.post<{ Params: { id: string } }>("/fixtures/:id/player-markets", async (request, reply) => {
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

  app.post<{ Params: { id: string } }>("/fixtures/:id/main-card-player-markets", async (request, reply) => {
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
        limitPerTeam: input.limitPerTeam
      });

      return { fixture, candidates };
    }
  );

  app.post<{ Params: { id: string } }>("/fixtures/:id/auto-main-card-player-markets", async (request, reply) => {
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
      limitPerTeam: input.limitPerTeam
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

  app.post("/markets/yes-no", async (request, reply) => {
    const input = createYesNoMarketSchema.parse(request.body);
    const market = createYesNoMarket(input);
    store.upsertMarket(market);

    return reply.code(201).send(market);
  });

  app.get("/markets", async () => ({
    markets: store.listMarkets()
  }));

  app.get<{ Params: { id: string } }>("/markets/:id", async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) {
      return reply.code(404).send({ error: "Market not found" });
    }

    return market;
  });

  app.post<{ Params: { id: string } }>("/markets/:id/create-on-chain", async (request, reply) => {
    const market = store.getMarket(request.params.id);
    if (!market) {
      return reply.code(404).send({ error: "Market not found" });
    }

    const input = createMarketOnChainSchema.parse(request.body ?? {});
    const result = await createMarketOnChain({
      marketId: market.id,
      questionId: input.questionId as Hex | undefined,
      marketType: market.type,
      metadataURI: input.metadataURI ?? `market:${market.id}`
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

  app.post<{ Params: { id: string } }>("/markets/:id/resolve", async (request, reply) => {
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

  app.post<{ Params: { id: string } }>("/markets/:id/submit-resolution", async (request, reply) => {
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

    const questionId = (input.questionId ?? hashIdentifier(market.id)) as Hex;
    const result = await resolveMarketOnChain(questionId, outcomeSideToResolverOutcome(decision.outcome));
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
    const mainMarkets = fixtureMarkets.filter((market) => market.template?.category !== "PLAYER");
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
