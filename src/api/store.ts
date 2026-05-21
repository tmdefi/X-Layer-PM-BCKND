import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { Fixture, MarketDefinition, ResolutionDecision } from "../markets/types.js";
import type { FixtureInsights } from "../sources/types.js";
import type { StoredClobFill, StoredClobOrder, StoredClobTrade } from "../trading/types.js";

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
  readonly clobOrders = new Map<string, StoredClobOrder>();
  readonly clobFills = new Map<string, StoredClobFill>();
  readonly clobTrades = new Map<string, StoredClobTrade>();

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

  upsertClobOrder(order: StoredClobOrder): StoredClobOrder {
    const updated = { ...order, updatedAt: new Date().toISOString() };
    this.clobOrders.set(updated.id, updated);
    return updated;
  }

  getClobOrder(id: string): StoredClobOrder | undefined {
    return this.clobOrders.get(id);
  }

  getClobOrderByHash(orderHash: string): StoredClobOrder | undefined {
    return [...this.clobOrders.values()].find((order) => order.orderHash.toLowerCase() === orderHash.toLowerCase());
  }

  listClobOrders(marketId?: string): StoredClobOrder[] {
    return [...this.clobOrders.values()]
      .filter((order) => !marketId || order.marketId === marketId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  recordClobTrade(trade: StoredClobTrade, fills: StoredClobFill[], orders: StoredClobOrder[]): StoredClobTrade {
    this.clobTrades.set(trade.id, trade);
    for (const fill of fills) this.clobFills.set(fill.id, fill);
    for (const order of orders) this.clobOrders.set(order.id, order);
    return trade;
  }

  listClobTrades(marketId?: string): StoredClobTrade[] {
    return [...this.clobTrades.values()]
      .filter((trade) => !marketId || trade.marketId === marketId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  listClobFills(orderId?: string): StoredClobFill[] {
    return [...this.clobFills.values()]
      .filter((fill) => !orderId || fill.orderId === orderId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async waitForPendingWrites(): Promise<void> {}
}

export class PrismaBackedStore extends InMemoryStore {
  private readonly pendingWrites = new Set<Promise<unknown>>();

  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async hydrate(): Promise<void> {
    const [fixtures, markets, resolutions, fixtureInsights, providerSyncLogs, clobOrders, clobFills, clobTrades] =
      await Promise.all([
      this.prisma.fixture.findMany(),
      this.prisma.market.findMany(),
      this.prisma.resolution.findMany(),
      this.prisma.fixtureInsightsCache.findMany(),
      this.prisma.providerSyncLog.findMany({ orderBy: { startedAt: "desc" }, take: 100 }),
      this.prisma.clobOrder.findMany(),
      this.prisma.clobFill.findMany(),
      this.prisma.clobTrade.findMany({ include: { makerOrders: true } })
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

    for (const order of clobOrders) {
      this.clobOrders.set(order.id, clobOrderFromPrisma(order));
    }

    for (const trade of clobTrades) {
      this.clobTrades.set(trade.id, {
        id: trade.id,
        marketId: trade.marketId,
        takerOrderId: trade.takerOrderId,
        makerOrderIds: trade.makerOrders.map((maker) => maker.makerOrderId),
        transactionHash: trade.transactionHash as StoredClobTrade["transactionHash"],
        takerFillAmount: trade.takerFillAmount,
        makerFillAmounts: trade.makerFillAmounts as string[],
        createdAt: trade.createdAt.toISOString()
      });
    }

    for (const fill of clobFills) {
      this.clobFills.set(fill.id, {
        id: fill.id,
        orderId: fill.orderId,
        tradeId: fill.tradeId,
        makerAmountFilled: fill.makerAmountFilled,
        takerAmountFilled: fill.takerAmountFilled,
        transactionHash: fill.transactionHash as StoredClobFill["transactionHash"],
        createdAt: fill.createdAt.toISOString()
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

  override upsertClobOrder(order: StoredClobOrder): StoredClobOrder {
    const stored = super.upsertClobOrder(order);
    this.persist(this.prisma.clobOrder.upsert({
      where: { id: stored.id },
      create: clobOrderToPrismaCreate(stored),
      update: clobOrderToPrismaUpdate(stored)
    }));
    return stored;
  }

  override recordClobTrade(
    trade: StoredClobTrade,
    fills: StoredClobFill[],
    orders: StoredClobOrder[]
  ): StoredClobTrade {
    const stored = super.recordClobTrade(trade, fills, orders);
    this.persist(this.prisma.$transaction([
      ...orders.map((order) =>
        this.prisma.clobOrder.upsert({
          where: { id: order.id },
          create: clobOrderToPrismaCreate(order),
          update: clobOrderToPrismaUpdate(order)
        })
      ),
      this.prisma.clobTrade.create({
        data: {
          id: trade.id,
          market: { connect: { id: trade.marketId } },
          takerOrder: { connect: { id: trade.takerOrderId } },
          transactionHash: trade.transactionHash,
          takerFillAmount: trade.takerFillAmount,
          makerFillAmounts: toJsonValue(trade.makerFillAmounts),
          createdAt: new Date(trade.createdAt),
          makerOrders: {
            create: trade.makerOrderIds.map((makerOrderId, index) => ({
              makerOrder: { connect: { id: makerOrderId } },
              fillAmount: trade.makerFillAmounts[index] ?? "0"
            }))
          },
          fills: {
            create: fills.map((fill) => ({
              id: fill.id,
              order: { connect: { id: fill.orderId } },
              makerAmountFilled: fill.makerAmountFilled,
              takerAmountFilled: fill.takerAmountFilled,
              transactionHash: fill.transactionHash,
              createdAt: new Date(fill.createdAt)
            }))
          }
        }
      })
    ]));
    return stored;
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

function clobOrderFromPrisma(order: {
  id: string;
  orderHash: string;
  marketId: string;
  outcomeSide: string;
  tokenId: string;
  side: string;
  maker: string;
  signer: string;
  taker: string;
  salt: string;
  makerAmount: string;
  takerAmount: string;
  remainingMaker: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  signatureType: number;
  signature: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): StoredClobOrder {
  return {
    id: order.id,
    orderHash: order.orderHash as StoredClobOrder["orderHash"],
    marketId: order.marketId,
    outcomeSide: order.outcomeSide as StoredClobOrder["outcomeSide"],
    side: order.side as StoredClobOrder["side"],
    order: {
      salt: order.salt,
      maker: order.maker as StoredClobOrder["order"]["maker"],
      signer: order.signer as StoredClobOrder["order"]["signer"],
      taker: order.taker as StoredClobOrder["order"]["taker"],
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      expiration: order.expiration,
      nonce: order.nonce,
      feeRateBps: order.feeRateBps,
      side: order.side === "BUY" ? 0 : 1,
      signatureType: order.signatureType as StoredClobOrder["order"]["signatureType"],
      signature: order.signature as StoredClobOrder["order"]["signature"]
    },
    remainingMaker: order.remainingMaker,
    status: order.status as StoredClobOrder["status"],
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString()
  };
}

function clobOrderToPrismaCreate(order: StoredClobOrder): Prisma.ClobOrderCreateInput {
  return {
    id: order.id,
    orderHash: order.orderHash,
    market: { connect: { id: order.marketId } },
    outcomeSide: order.outcomeSide,
    tokenId: order.order.tokenId,
    side: order.side,
    maker: order.order.maker,
    signer: order.order.signer,
    taker: order.order.taker,
    salt: order.order.salt,
    makerAmount: order.order.makerAmount,
    takerAmount: order.order.takerAmount,
    remainingMaker: order.remainingMaker,
    expiration: order.order.expiration,
    nonce: order.order.nonce,
    feeRateBps: order.order.feeRateBps,
    signatureType: order.order.signatureType,
    signature: order.order.signature,
    status: order.status,
    createdAt: new Date(order.createdAt),
    updatedAt: new Date(order.updatedAt)
  };
}

function clobOrderToPrismaUpdate(order: StoredClobOrder): Prisma.ClobOrderUpdateInput {
  return {
    outcomeSide: order.outcomeSide,
    tokenId: order.order.tokenId,
    side: order.side,
    maker: order.order.maker,
    signer: order.order.signer,
    taker: order.order.taker,
    salt: order.order.salt,
    makerAmount: order.order.makerAmount,
    takerAmount: order.order.takerAmount,
    remainingMaker: order.remainingMaker,
    expiration: order.order.expiration,
    nonce: order.order.nonce,
    feeRateBps: order.order.feeRateBps,
    signatureType: order.order.signatureType,
    signature: order.order.signature,
    status: order.status,
    updatedAt: new Date(order.updatedAt)
  };
}
