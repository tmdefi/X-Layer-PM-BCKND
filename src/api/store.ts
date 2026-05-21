import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { Fixture, MarketDefinition, ResolutionDecision } from "../markets/types.js";
import type { FixtureInsights } from "../sources/types.js";

export type FixtureInsightsCacheEntry = {
  insights: FixtureInsights;
  cachedAt: string;
  expiresAt: string;
};

export type ProviderSyncLog = {
  id: string;
  provider: string;
  jobType: string;
  status: string;
  startedAt: string;
  finishedAt?: string | undefined;
  details?: unknown;
};

export type ProviderSyncLogInput = Omit<ProviderSyncLog, "id"> & {
  id?: string | undefined;
};

export class InMemoryStore {
  readonly fixtures = new Map<string, Fixture>();
  readonly markets = new Map<string, MarketDefinition>();
  readonly resolutions = new Map<string, ResolutionDecision>();
  readonly fixtureInsights = new Map<string, FixtureInsightsCacheEntry>();
  readonly providerSyncLogs = new Map<string, ProviderSyncLog>();

  upsertFixture(fixture: Fixture): Fixture {
    this.fixtures.set(fixture.id, fixture);
    return fixture;
  }

  upsertFixtures(fixtures: Fixture[]): Fixture[] {
    for (const fixture of fixtures) {
      this.fixtures.set(fixture.id, fixture);
    }

    return fixtures;
  }

  listFixtures(): Fixture[] {
    return [...this.fixtures.values()];
  }

  getFixture(id: string): Fixture | undefined {
    return this.fixtures.get(id);
  }

  upsertMarket(market: MarketDefinition): MarketDefinition {
    this.markets.set(market.id, market);
    return market;
  }

  upsertMarkets(markets: MarketDefinition[]): MarketDefinition[] {
    for (const market of markets) {
      this.markets.set(market.id, market);
    }

    return markets;
  }

  listMarkets(): MarketDefinition[] {
    return [...this.markets.values()];
  }

  getMarket(id: string): MarketDefinition | undefined {
    return this.markets.get(id);
  }

  updateMarket(market: MarketDefinition): MarketDefinition {
    this.markets.set(market.id, market);
    return market;
  }

  upsertResolution(decision: ResolutionDecision): ResolutionDecision {
    this.resolutions.set(decision.marketId, decision);
    return decision;
  }

  getResolution(marketId: string): ResolutionDecision | undefined {
    return this.resolutions.get(marketId);
  }

  listResolutions(): ResolutionDecision[] {
    return [...this.resolutions.values()];
  }

  getFixtureInsights(cacheKey: string, now = new Date()): FixtureInsightsCacheEntry | undefined {
    const entry = this.fixtureInsights.get(cacheKey);
    if (!entry) return undefined;

    if (Date.parse(entry.expiresAt) <= now.getTime()) {
      this.fixtureInsights.delete(cacheKey);
      return undefined;
    }

    return entry;
  }

  upsertFixtureInsights(cacheKey: string, insights: FixtureInsights, ttlMs: number, now = new Date()): FixtureInsightsCacheEntry {
    const entry = {
      insights,
      cachedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString()
    };
    this.fixtureInsights.set(cacheKey, entry);
    return entry;
  }

  upsertProviderSyncLog(input: ProviderSyncLogInput): ProviderSyncLog {
    const log: ProviderSyncLog = {
      id: input.id ?? randomUUID(),
      provider: input.provider,
      jobType: input.jobType,
      status: input.status,
      startedAt: input.startedAt,
      ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
      ...(input.details !== undefined ? { details: input.details } : {})
    };
    this.providerSyncLogs.set(log.id, log);
    return log;
  }

  listProviderSyncLogs(limit = 50): ProviderSyncLog[] {
    return [...this.providerSyncLogs.values()]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit);
  }

  async waitForPendingWrites(): Promise<void> {}
}

export class PrismaBackedStore extends InMemoryStore {
  private readonly pendingWrites = new Set<Promise<unknown>>();

  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async hydrate(): Promise<void> {
    const [fixtures, markets, resolutions, fixtureInsights, providerSyncLogs] = await Promise.all([
      this.prisma.fixture.findMany(),
      this.prisma.market.findMany(),
      this.prisma.resolution.findMany(),
      this.prisma.fixtureInsightsCache.findMany(),
      this.prisma.providerSyncLog.findMany({ orderBy: { startedAt: "desc" }, take: 100 })
    ]);

    for (const fixture of fixtures) {
      this.fixtures.set(fixture.id, {
        id: fixture.id,
        sport: fixture.sport as Fixture["sport"],
        source: fixture.source as Fixture["source"],
        homeCompetitor: fixture.homeCompetitor,
        awayCompetitor: fixture.awayCompetitor,
        ...(fixture.homeLogoUrl ? { homeLogoUrl: fixture.homeLogoUrl } : {}),
        ...(fixture.awayLogoUrl ? { awayLogoUrl: fixture.awayLogoUrl } : {}),
        kickoffTime: fixture.kickoffTime.toISOString(),
        status: fixture.status as Fixture["status"]
      });
    }

    for (const market of markets) {
      this.markets.set(market.id, {
        id: market.id,
        ...(market.fixtureId ? { fixtureId: market.fixtureId } : {}),
        type: market.type as MarketDefinition["type"],
        title: market.title,
        status: market.status as MarketDefinition["status"],
        ...(market.source ? { source: market.source as MarketDefinition["source"] } : {}),
        ...(market.resolver ? { resolver: market.resolver as MarketDefinition["resolver"] } : {}),
        outcomes: market.outcomes as unknown as MarketDefinition["outcomes"],
        ...(market.conditionId ? { conditionId: market.conditionId } : {}),
        ...(market.template ? { template: market.template as MarketDefinition["template"] } : {}),
        ...(market.sport ? { sport: market.sport } : {}),
        ...(market.line ? { line: market.line } : {})
      } as MarketDefinition);
    }

    for (const resolution of resolutions) {
      this.resolutions.set(resolution.marketId, {
        marketId: resolution.marketId,
        marketType: resolution.marketType as ResolutionDecision["marketType"],
        outcome: resolution.outcome as ResolutionDecision["outcome"],
        payoutVector: resolution.payoutVector as unknown as ResolutionDecision["payoutVector"],
        status: resolution.status as ResolutionDecision["status"],
        source: resolution.source as ResolutionDecision["source"],
        observedAt: resolution.observedAt.toISOString(),
        computedAt: resolution.computedAt.toISOString(),
        reason: resolution.reason
      });
    }

    for (const entry of fixtureInsights) {
      if (entry.expiresAt.getTime() <= Date.now()) continue;
      this.fixtureInsights.set(entry.cacheKey, {
        insights: entry.insights as FixtureInsights,
        cachedAt: entry.cachedAt.toISOString(),
        expiresAt: entry.expiresAt.toISOString()
      });
    }

    for (const log of providerSyncLogs) {
      this.providerSyncLogs.set(log.id, {
        id: log.id,
        provider: log.provider,
        jobType: log.jobType,
        status: log.status,
        startedAt: log.startedAt.toISOString(),
        ...(log.finishedAt ? { finishedAt: log.finishedAt.toISOString() } : {}),
        ...(log.details !== null ? { details: log.details } : {})
      });
    }
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  override upsertFixture(fixture: Fixture): Fixture {
    const stored = super.upsertFixture(fixture);
    this.persist(this.prisma.fixture.upsert({
      where: { id: fixture.id },
      create: {
        id: fixture.id,
        sport: fixture.sport,
        source: toJsonValue(fixture.source),
        homeCompetitor: fixture.homeCompetitor,
        awayCompetitor: fixture.awayCompetitor,
        homeLogoUrl: fixture.homeLogoUrl ?? null,
        awayLogoUrl: fixture.awayLogoUrl ?? null,
        kickoffTime: new Date(fixture.kickoffTime),
        status: fixture.status
      },
      update: {
        sport: fixture.sport,
        source: toJsonValue(fixture.source),
        homeCompetitor: fixture.homeCompetitor,
        awayCompetitor: fixture.awayCompetitor,
        homeLogoUrl: fixture.homeLogoUrl ?? null,
        awayLogoUrl: fixture.awayLogoUrl ?? null,
        kickoffTime: new Date(fixture.kickoffTime),
        status: fixture.status
      }
    }));

    return stored;
  }

  override upsertFixtures(fixtures: Fixture[]): Fixture[] {
    const stored = super.upsertFixtures(fixtures);
    this.persist(this.prisma.$transaction(
      fixtures.map((fixture) =>
        this.prisma.fixture.upsert({
          where: { id: fixture.id },
          create: fixtureToPrismaCreate(fixture),
          update: fixtureToPrismaUpdate(fixture)
        })
      )
    ));

    return stored;
  }

  override upsertMarket(market: MarketDefinition): MarketDefinition {
    const stored = super.upsertMarket(market);
    this.persist(this.prisma.market.upsert({
      where: { id: market.id },
      create: marketToPrismaCreate(market),
      update: marketToPrismaUpdate(market)
    }));

    return stored;
  }

  override upsertMarkets(markets: MarketDefinition[]): MarketDefinition[] {
    const stored = super.upsertMarkets(markets);
    this.persist(this.prisma.$transaction(
      markets.map((market) =>
        this.prisma.market.upsert({
          where: { id: market.id },
          create: marketToPrismaCreate(market),
          update: marketToPrismaUpdate(market)
        })
      )
    ));

    return stored;
  }

  override updateMarket(market: MarketDefinition): MarketDefinition {
    return this.upsertMarket(market);
  }

  override upsertResolution(decision: ResolutionDecision): ResolutionDecision {
    const stored = super.upsertResolution(decision);
    this.persist(this.prisma.resolution.upsert({
      where: { marketId: decision.marketId },
      create: {
        marketId: decision.marketId,
        marketType: decision.marketType,
        outcome: decision.outcome,
        payoutVector: toJsonValue(decision.payoutVector),
        status: decision.status,
        source: toJsonValue(decision.source),
        observedAt: new Date(decision.observedAt),
        computedAt: new Date(decision.computedAt),
        reason: decision.reason
      },
      update: {
        marketType: decision.marketType,
        outcome: decision.outcome,
        payoutVector: toJsonValue(decision.payoutVector),
        status: decision.status,
        source: toJsonValue(decision.source),
        observedAt: new Date(decision.observedAt),
        computedAt: new Date(decision.computedAt),
        reason: decision.reason
      }
    }));

    return stored;
  }

  override upsertFixtureInsights(
    cacheKey: string,
    insights: FixtureInsights,
    ttlMs: number,
    now = new Date()
  ): FixtureInsightsCacheEntry {
    const entry = super.upsertFixtureInsights(cacheKey, insights, ttlMs, now);
    this.persist(this.prisma.fixtureInsightsCache.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        insights: toJsonValue(entry.insights),
        cachedAt: new Date(entry.cachedAt),
        expiresAt: new Date(entry.expiresAt)
      },
      update: {
        insights: toJsonValue(entry.insights),
        cachedAt: new Date(entry.cachedAt),
        expiresAt: new Date(entry.expiresAt)
      }
    }));

    return entry;
  }

  override upsertProviderSyncLog(input: ProviderSyncLogInput): ProviderSyncLog {
    const log = super.upsertProviderSyncLog(input);
    this.persist(this.prisma.providerSyncLog.upsert({
      where: { id: log.id },
      create: {
        id: log.id,
        provider: log.provider,
        jobType: log.jobType,
        status: log.status,
        startedAt: new Date(log.startedAt),
        finishedAt: log.finishedAt ? new Date(log.finishedAt) : null,
        details: log.details !== undefined ? toJsonValue(log.details) : Prisma.DbNull
      },
      update: {
        provider: log.provider,
        jobType: log.jobType,
        status: log.status,
        startedAt: new Date(log.startedAt),
        finishedAt: log.finishedAt ? new Date(log.finishedAt) : null,
        details: log.details !== undefined ? toJsonValue(log.details) : Prisma.DbNull
      }
    }));

    return log;
  }

  override async waitForPendingWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.all([...this.pendingWrites]);
    }
  }

  private persist<T>(operation: Promise<T>): void {
    const pending = operation.catch((error: unknown) => {
      console.error("Database persistence failed", error);
    }).finally(() => {
      this.pendingWrites.delete(pending);
    });
    this.pendingWrites.add(pending);
  }
}

export async function createStore(): Promise<InMemoryStore> {
  if (!env.DATABASE_ENABLED) {
    return new InMemoryStore();
  }

  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when DATABASE_ENABLED=true");
  }

  const adapter = new PrismaPg({
    connectionString: prismaPgConnectionString(env.DATABASE_URL),
    ssl: {
      rejectUnauthorized: false
    }
  });
  const store = new PrismaBackedStore(new PrismaClient({ adapter }));
  await store.hydrate();
  return store;
}

function prismaPgConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  if (url.searchParams.get("sslmode") === "require" && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}

function marketToPrismaCreate(market: MarketDefinition): Prisma.MarketCreateInput {
  return {
    id: market.id,
    type: market.type,
    title: market.title,
    status: market.status,
    ...(market.fixtureId ? { fixture: { connect: { id: market.fixtureId } } } : {}),
    ...(market.source ? { source: toJsonValue(market.source) } : {}),
    ...(market.resolver ? { resolver: toJsonValue(market.resolver) } : {}),
    outcomes: toJsonValue(market.outcomes),
    ...(market.conditionId ? { conditionId: market.conditionId } : {}),
    ...(market.template ? { template: toJsonValue(market.template) } : {}),
    ...marketShapeFields(market)
  };
}

function fixtureToPrismaCreate(fixture: Fixture): Prisma.FixtureCreateInput {
  return {
    id: fixture.id,
    sport: fixture.sport,
    source: toJsonValue(fixture.source),
    homeCompetitor: fixture.homeCompetitor,
    awayCompetitor: fixture.awayCompetitor,
    homeLogoUrl: fixture.homeLogoUrl ?? null,
    awayLogoUrl: fixture.awayLogoUrl ?? null,
    kickoffTime: new Date(fixture.kickoffTime),
    status: fixture.status
  };
}

function fixtureToPrismaUpdate(fixture: Fixture): Prisma.FixtureUpdateInput {
  return {
    sport: fixture.sport,
    source: toJsonValue(fixture.source),
    homeCompetitor: fixture.homeCompetitor,
    awayCompetitor: fixture.awayCompetitor,
    homeLogoUrl: fixture.homeLogoUrl ?? null,
    awayLogoUrl: fixture.awayLogoUrl ?? null,
    kickoffTime: new Date(fixture.kickoffTime),
    status: fixture.status
  };
}

function marketToPrismaUpdate(market: MarketDefinition): Prisma.MarketUpdateInput {
  return {
    type: market.type,
    title: market.title,
    status: market.status,
    ...(market.fixtureId ? { fixture: { connect: { id: market.fixtureId } } } : { fixture: { disconnect: true } }),
    source: market.source ? toJsonValue(market.source) : Prisma.DbNull,
    resolver: market.resolver ? toJsonValue(market.resolver) : Prisma.DbNull,
    outcomes: toJsonValue(market.outcomes),
    conditionId: market.conditionId ?? null,
    template: market.template ? toJsonValue(market.template) : Prisma.DbNull,
    ...marketShapeFields(market)
  };
}

function marketShapeFields(market: MarketDefinition): { sport?: string; line?: string } {
  return {
    ...("sport" in market ? { sport: market.sport } : {}),
    ...("line" in market ? { line: market.line } : {})
  };
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
