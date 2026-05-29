import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { Fixture, MarketDefinition, ResolutionDecision } from "../markets/types.js";
import type { FixtureInsights, PlayerCandidate } from "../sources/types.js";
import type { StoredClobFill, StoredClobOrder, StoredClobTrade } from "../trading/types.js";
import { MarketEventHub, type MarketRealtimeEventInput } from "./market-events.js";
import type { OperatorTransaction, OperatorTransactionInput } from "./operator-transactions.js";

export type FixtureInsightsCacheEntry = {
  insights: FixtureInsights;
  cachedAt: string;
  expiresAt: string;
};

export type PlayerCandidateCacheEntry = {
  candidates: PlayerCandidate[];
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
  readonly marketEvents = new MarketEventHub();
  readonly fixtures = new Map<string, Fixture>();
  readonly markets = new Map<string, MarketDefinition>();
  readonly resolutions = new Map<string, ResolutionDecision>();
  readonly fixtureInsights = new Map<string, FixtureInsightsCacheEntry>();
  readonly playerCandidates = new Map<string, PlayerCandidateCacheEntry>();
  readonly providerSyncLogs = new Map<string, ProviderSyncLog>();
  readonly operatorTransactions = new Map<string, OperatorTransaction>();
  readonly clobOrders = new Map<string, StoredClobOrder>();
  readonly clobFills = new Map<string, StoredClobFill>();
  readonly clobTrades = new Map<string, StoredClobTrade>();
  private readonly clobOrderIdsByMarket = new Map<string, Set<string>>();
  private readonly clobTradeIdsByMarket = new Map<string, Set<string>>();

  upsertFixture(fixture: Fixture): Fixture {
    const current = this.fixtures.get(fixture.id);
    this.fixtures.set(fixture.id, fixture);
    if (current && current.status !== fixture.status) {
      this.marketEvents.publish({
        type: "fixture.status_changed",
        fixtureId: fixture.id,
        fixture
      });
    }
    return fixture;
  }

  upsertFixtures(fixtures: Fixture[]): Fixture[] {
    for (const fixture of fixtures) {
      const current = this.fixtures.get(fixture.id);
      this.fixtures.set(fixture.id, fixture);
      if (current && current.status !== fixture.status) {
        this.marketEvents.publish({
          type: "fixture.status_changed",
          fixtureId: fixture.id,
          fixture
        });
      }
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
    const current = this.markets.get(market.id);
    this.markets.set(market.id, market);
    if (!current) {
      this.marketEvents.publish({
        type: "market.created",
        market
      });
    }
    this.publishTradingStatusChange(current, market);
    return market;
  }

  upsertMarkets(markets: MarketDefinition[]): MarketDefinition[] {
    for (const market of markets) {
      const current = this.markets.get(market.id);
      this.markets.set(market.id, market);
      if (!current) {
        this.marketEvents.publish({
          type: "market.created",
          market
        });
      }
      this.publishTradingStatusChange(current, market);
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
    return this.upsertMarket(market);
  }

  upsertResolution(decision: ResolutionDecision): ResolutionDecision {
    const current = this.resolutions.get(decision.marketId);
    this.resolutions.set(decision.marketId, decision);
    if (
      decision.earlyResolution &&
      !decision.earlyResolution.confirmedAt &&
      earlyResolutionEventKey(current) !== earlyResolutionEventKey(decision)
    ) {
      this.marketEvents.publish({
        type: "market.early_resolution_candidate",
        marketId: decision.marketId,
        resolution: decision
      });
    }
    if (decision.status === "submitted" && current?.status !== "submitted") {
      this.marketEvents.publish({
        type: "market.resolution_submitted",
        marketId: decision.marketId,
        resolution: decision
      });
      if (decision.outcome !== "VOID") {
        this.marketEvents.publish({
          type: "market.redeemable",
          marketId: decision.marketId,
          winningOutcome: decision.outcome,
          resolution: decision
        });
      }
    }
    return decision;
  }

  getResolution(marketId: string): ResolutionDecision | undefined {
    return this.resolutions.get(marketId);
  }

  listResolutions(): ResolutionDecision[] {
    return [...this.resolutions.values()];
  }

  publishMarketEvent(input: MarketRealtimeEventInput) {
    return this.marketEvents.publish(input);
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

  getPlayerCandidates(cacheKey: string, now = new Date()): PlayerCandidateCacheEntry | undefined {
    const entry = this.playerCandidates.get(cacheKey);
    if (!entry) return undefined;

    if (Date.parse(entry.expiresAt) <= now.getTime()) {
      this.playerCandidates.delete(cacheKey);
      return undefined;
    }

    return entry;
  }

  upsertPlayerCandidates(
    cacheKey: string,
    candidates: PlayerCandidate[],
    ttlMs: number,
    now = new Date()
  ): PlayerCandidateCacheEntry {
    const entry = {
      candidates,
      cachedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString()
    };
    this.playerCandidates.set(cacheKey, entry);
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

  upsertOperatorTransaction(input: OperatorTransactionInput): OperatorTransaction {
    const current = this.operatorTransactions.get(input.id);
    const now = new Date().toISOString();
    const transaction: OperatorTransaction = {
      ...input,
      createdAt: input.createdAt ?? current?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now
    };
    this.operatorTransactions.set(transaction.id, transaction);
    return transaction;
  }

  getOperatorTransaction(id: string): OperatorTransaction | undefined {
    return this.operatorTransactions.get(id);
  }

  listOperatorTransactions(input: {
    status?: OperatorTransaction["status"] | undefined;
    action?: OperatorTransaction["action"] | undefined;
    entityId?: string | undefined;
    limit?: number | undefined;
  } = {}): OperatorTransaction[] {
    return [...this.operatorTransactions.values()]
      .filter((transaction) => !input.status || transaction.status === input.status)
      .filter((transaction) => !input.action || transaction.action === input.action)
      .filter((transaction) => !input.entityId || transaction.entityId === input.entityId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, input.limit ?? 100);
  }

  getActiveOperatorTransaction(
    action: OperatorTransaction["action"],
    entityId: string
  ): OperatorTransaction | undefined {
    return this.listOperatorTransactions({ action, entityId }).find((transaction) =>
      transaction.status === "attempted" || transaction.status === "pending"
    );
  }

  upsertClobOrder(order: StoredClobOrder): StoredClobOrder {
    const updated = { ...order, updatedAt: new Date().toISOString() };
    this.setClobOrder(updated);
    return updated;
  }

  getClobOrder(id: string): StoredClobOrder | undefined {
    return this.clobOrders.get(id);
  }

  getClobOrderByHash(orderHash: string): StoredClobOrder | undefined {
    return [...this.clobOrders.values()].find((order) => order.orderHash.toLowerCase() === orderHash.toLowerCase());
  }

  listClobOrders(marketId?: string): StoredClobOrder[] {
    const orders = marketId
      ? [...(this.clobOrderIdsByMarket.get(marketId) ?? [])]
        .map((id) => this.clobOrders.get(id))
        .filter((order): order is StoredClobOrder => Boolean(order))
      : [...this.clobOrders.values()];
    return orders
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  recordClobTrade(trade: StoredClobTrade, fills: StoredClobFill[], orders: StoredClobOrder[]): StoredClobTrade {
    this.setClobTrade(trade);
    for (const fill of fills) this.clobFills.set(fill.id, fill);
    for (const order of orders) this.setClobOrder(order);
    return trade;
  }

  listClobTrades(marketId?: string): StoredClobTrade[] {
    const trades = marketId
      ? [...(this.clobTradeIdsByMarket.get(marketId) ?? [])]
        .map((id) => this.clobTrades.get(id))
        .filter((trade): trade is StoredClobTrade => Boolean(trade))
      : [...this.clobTrades.values()];
    return trades
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  getClobTradeByTransactionHash(transactionHash: StoredClobTrade["transactionHash"]): StoredClobTrade | undefined {
    return [...this.clobTrades.values()].find((trade) =>
      trade.transactionHash.toLowerCase() === transactionHash.toLowerCase()
    );
  }

  listClobFills(orderId?: string): StoredClobFill[] {
    return [...this.clobFills.values()]
      .filter((fill) => !orderId || fill.orderId === orderId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async waitForPendingWrites(): Promise<void> {}

  protected setClobOrder(order: StoredClobOrder): void {
    const current = this.clobOrders.get(order.id);
    if (current?.marketId && current.marketId !== order.marketId) {
      this.clobOrderIdsByMarket.get(current.marketId)?.delete(order.id);
    }
    this.clobOrders.set(order.id, order);
    const marketOrders = this.clobOrderIdsByMarket.get(order.marketId) ?? new Set<string>();
    marketOrders.add(order.id);
    this.clobOrderIdsByMarket.set(order.marketId, marketOrders);
  }

  protected setClobTrade(trade: StoredClobTrade): void {
    const current = this.clobTrades.get(trade.id);
    if (current?.marketId && current.marketId !== trade.marketId) {
      this.clobTradeIdsByMarket.get(current.marketId)?.delete(trade.id);
    }
    this.clobTrades.set(trade.id, trade);
    const marketTrades = this.clobTradeIdsByMarket.get(trade.marketId) ?? new Set<string>();
    marketTrades.add(trade.id);
    this.clobTradeIdsByMarket.set(trade.marketId, marketTrades);
  }

  private publishTradingStatusChange(
    current: MarketDefinition | undefined,
    market: MarketDefinition
  ): void {
    if (!current || current.tradingStatus === market.tradingStatus) return;

    this.marketEvents.publish({
      type: "market.trading_status_changed",
      marketId: market.id,
      status: market.status,
      tradingStatus: market.tradingStatus,
      ...(market.tradingStatusReason ? { reason: market.tradingStatusReason } : {})
    });
  }
}

function earlyResolutionEventKey(decision: ResolutionDecision | undefined): string | undefined {
  const confirmation = decision?.earlyResolution;
  if (!confirmation || confirmation.confirmedAt) return undefined;
  return `${confirmation.evidenceKey}:${confirmation.observationCount}:${confirmation.lastObservedAt}`;
}

export class PrismaBackedStore extends InMemoryStore {
  private readonly pendingWrites = new Set<Promise<unknown>>();

  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async hydrate(): Promise<void> {
    const [fixtures, markets, resolutions, fixtureInsights, playerCandidates, providerSyncLogs, operatorTransactions, clobOrders, clobFills, clobTrades] =
      await Promise.all([
      this.prisma.fixture.findMany(),
      this.prisma.market.findMany(),
      this.prisma.resolution.findMany(),
      this.prisma.fixtureInsightsCache.findMany(),
      this.prisma.playerCandidateCache.findMany(),
      this.prisma.providerSyncLog.findMany({ orderBy: { startedAt: "desc" }, take: 100 }),
      this.prisma.operatorTransaction.findMany({ orderBy: { updatedAt: "desc" }, take: 500 }),
      this.prisma.clobOrder.findMany(),
      this.prisma.clobFill.findMany(),
      this.prisma.clobTrade.findMany({ include: { makerOrders: true } })
    ]);

    for (const fixture of fixtures) {
      this.fixtures.set(fixture.id, {
        id: fixture.id,
        sport: fixture.sport as Fixture["sport"],
        source: fixture.source as Fixture["source"],
        ...(fixture.competition ? { competition: fixture.competition as Fixture["competition"] } : {}),
        homeCompetitor: fixture.homeCompetitor,
        awayCompetitor: fixture.awayCompetitor,
        ...(fixture.homeLogoUrl ? { homeLogoUrl: fixture.homeLogoUrl } : {}),
        ...(fixture.awayLogoUrl ? { awayLogoUrl: fixture.awayLogoUrl } : {}),
        kickoffTime: fixture.kickoffTime.toISOString(),
        status: fixture.status as Fixture["status"]
      });
    }

    for (const market of markets) {
      const fixedTradingStatus = fixStaleTradingStatus(market.status, market.tradingStatus as string | undefined);
      this.markets.set(market.id, {
        id: market.id,
        ...(market.fixtureId ? { fixtureId: market.fixtureId } : {}),
        type: market.type as MarketDefinition["type"],
        title: market.title,
        status: market.status as MarketDefinition["status"],
        tradingStatus: fixedTradingStatus ?? (market.tradingStatus as MarketDefinition["tradingStatus"]),
        ...(market.tradingStatusReason ? { tradingStatusReason: market.tradingStatusReason } : {}),
        ...(market.tradingStatusUpdatedAt ? { tradingStatusUpdatedAt: market.tradingStatusUpdatedAt.toISOString() } : {}),
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
        reason: resolution.reason,
        ...(resolution.earlyResolution
          ? { earlyResolution: resolution.earlyResolution as ResolutionDecision["earlyResolution"] }
          : {})
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

    for (const entry of playerCandidates) {
      if (entry.expiresAt.getTime() <= Date.now()) continue;
      this.playerCandidates.set(entry.cacheKey, {
        candidates: entry.candidates as unknown as PlayerCandidate[],
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

    for (const transaction of operatorTransactions) {
      this.operatorTransactions.set(transaction.id, {
        id: transaction.id,
        action: transaction.action as OperatorTransaction["action"],
        entityId: transaction.entityId,
        status: transaction.status as OperatorTransaction["status"],
        ...(transaction.txHash ? { txHash: transaction.txHash as OperatorTransaction["txHash"] } : {}),
        ...(transaction.metadata ? { metadata: transaction.metadata } : {}),
        ...(transaction.result ? { result: transaction.result } : {}),
        ...(transaction.error ? { error: transaction.error } : {}),
        createdAt: transaction.createdAt.toISOString(),
        updatedAt: transaction.updatedAt.toISOString(),
        ...(transaction.submittedAt ? { submittedAt: transaction.submittedAt.toISOString() } : {}),
        ...(transaction.confirmedAt ? { confirmedAt: transaction.confirmedAt.toISOString() } : {}),
        ...(transaction.failedAt ? { failedAt: transaction.failedAt.toISOString() } : {})
      });
    }

    for (const order of clobOrders) {
      this.setClobOrder(clobOrderFromPrisma(order));
    }

    for (const trade of clobTrades) {
      this.setClobTrade({
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
        competition: fixture.competition ? toJsonValue(fixture.competition) : Prisma.DbNull,
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
        competition: fixture.competition ? toJsonValue(fixture.competition) : Prisma.DbNull,
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
    this.persist(persistBatches(batches(fixtures, 25), (batch) =>
      Promise.all(batch.map((fixture) =>
        this.prisma.fixture.upsert({
          where: { id: fixture.id },
          create: fixtureToPrismaCreate(fixture),
          update: fixtureToPrismaUpdate(fixture)
        })
      ))
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
    this.persist(persistBatches(batches(markets, 10), (batch) =>
      Promise.all(batch.map((market) =>
        this.prisma.market.upsert({
          where: { id: market.id },
          create: marketToPrismaCreate(market),
          update: marketToPrismaUpdate(market)
        })
      ))
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
        reason: decision.reason,
        ...(decision.earlyResolution ? { earlyResolution: toJsonValue(decision.earlyResolution) } : {})
      },
      update: {
        marketType: decision.marketType,
        outcome: decision.outcome,
        payoutVector: toJsonValue(decision.payoutVector),
        status: decision.status,
        source: toJsonValue(decision.source),
        observedAt: new Date(decision.observedAt),
        computedAt: new Date(decision.computedAt),
        reason: decision.reason,
        earlyResolution: decision.earlyResolution
          ? toJsonValue(decision.earlyResolution)
          : Prisma.DbNull
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

  override upsertPlayerCandidates(
    cacheKey: string,
    candidates: PlayerCandidate[],
    ttlMs: number,
    now = new Date()
  ): PlayerCandidateCacheEntry {
    const entry = super.upsertPlayerCandidates(cacheKey, candidates, ttlMs, now);
    this.persist(this.prisma.playerCandidateCache.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        candidates: toJsonValue(entry.candidates),
        cachedAt: new Date(entry.cachedAt),
        expiresAt: new Date(entry.expiresAt)
      },
      update: {
        candidates: toJsonValue(entry.candidates),
        cachedAt: new Date(entry.cachedAt),
        expiresAt: new Date(entry.expiresAt)
      }
    }));
    return entry;
  }

  override upsertOperatorTransaction(input: OperatorTransactionInput): OperatorTransaction {
    const transaction = super.upsertOperatorTransaction(input);
    this.persist(this.prisma.operatorTransaction.upsert({
      where: { id: transaction.id },
      create: operatorTransactionToPrisma(transaction),
      update: operatorTransactionToPrismaUpdate(transaction)
    }));
    return transaction;
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
    tradingStatus: market.tradingStatus,
    ...(market.tradingStatusReason ? { tradingStatusReason: market.tradingStatusReason } : {}),
    ...(market.tradingStatusUpdatedAt ? { tradingStatusUpdatedAt: new Date(market.tradingStatusUpdatedAt) } : {}),
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
    ...(fixture.competition ? { competition: toJsonValue(fixture.competition) } : {}),
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
    competition: fixture.competition ? toJsonValue(fixture.competition) : Prisma.DbNull,
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
    tradingStatus: market.tradingStatus,
    tradingStatusReason: market.tradingStatusReason ?? null,
    tradingStatusUpdatedAt: market.tradingStatusUpdatedAt ? new Date(market.tradingStatusUpdatedAt) : null,
    ...(market.fixtureId ? { fixture: { connect: { id: market.fixtureId } } } : { fixture: { disconnect: true } }),
    source: market.source ? toJsonValue(market.source) : Prisma.DbNull,
    resolver: market.resolver ? toJsonValue(market.resolver) : Prisma.DbNull,
    outcomes: toJsonValue(market.outcomes),
    conditionId: market.conditionId ?? null,
    template: market.template ? toJsonValue(market.template) : Prisma.DbNull,
    ...marketShapeFields(market)
  };
}

function operatorTransactionToPrisma(transaction: OperatorTransaction): Prisma.OperatorTransactionCreateInput {
  return {
    id: transaction.id,
    action: transaction.action,
    entityId: transaction.entityId,
    status: transaction.status,
    txHash: transaction.txHash ?? null,
    metadata: transaction.metadata !== undefined ? toJsonValue(transaction.metadata) : Prisma.DbNull,
    result: transaction.result !== undefined ? toJsonValue(transaction.result) : Prisma.DbNull,
    error: transaction.error ?? null,
    submittedAt: transaction.submittedAt ? new Date(transaction.submittedAt) : null,
    confirmedAt: transaction.confirmedAt ? new Date(transaction.confirmedAt) : null,
    failedAt: transaction.failedAt ? new Date(transaction.failedAt) : null,
    createdAt: new Date(transaction.createdAt),
    updatedAt: new Date(transaction.updatedAt)
  };
}

function operatorTransactionToPrismaUpdate(transaction: OperatorTransaction): Prisma.OperatorTransactionUpdateInput {
  return {
    action: transaction.action,
    entityId: transaction.entityId,
    status: transaction.status,
    txHash: transaction.txHash ?? null,
    metadata: transaction.metadata !== undefined ? toJsonValue(transaction.metadata) : Prisma.DbNull,
    result: transaction.result !== undefined ? toJsonValue(transaction.result) : Prisma.DbNull,
    error: transaction.error ?? null,
    submittedAt: transaction.submittedAt ? new Date(transaction.submittedAt) : null,
    confirmedAt: transaction.confirmedAt ? new Date(transaction.confirmedAt) : null,
    failedAt: transaction.failedAt ? new Date(transaction.failedAt) : null,
    updatedAt: new Date(transaction.updatedAt)
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

function batches<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function persistBatches<T>(
  values: T[][],
  persist: (batch: T[]) => Promise<unknown>
): Promise<void> {
  for (const batch of values) {
    await persist(batch);
  }
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

function fixStaleTradingStatus(status: string, tradingStatus: string | undefined): string | undefined {
  if (!tradingStatus) return undefined;
  const isTerminal = status === "closed" || status === "resolved" || status === "cancelled";
  if (!isTerminal && tradingStatus === "closed") return "open";
  return undefined;
}
