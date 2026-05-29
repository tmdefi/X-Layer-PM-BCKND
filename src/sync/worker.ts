import { env } from "../config/env.js";
import {
  createMarketOnChain,
  createPublicChainClient,
  getMarketOnChain,
  marketUsesCurrentCollateral,
  requireAddress,
  type OnChainStoredMarket
} from "../chain/index.js";
import { createBasketballFixtureMarkets, createEsportsFixtureMarkets, createFootballFixtureMarkets, createMmaFixtureMarkets } from "../markets/definitions.js";
import type { BasketballFixture, EsportsFixture, Fixture, FootballFixture, MarketDefinition, MmaFixture, Sport } from "../markets/types.js";
import type { InMemoryStore } from "../api/store.js";
import { runTrackedOperatorTransaction } from "../api/operator-transactions.js";
import type { FixtureQuery, SourceRegistry } from "../sources/index.js";

type SyncLogger = {
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
};

export type ProviderSyncWorkerOptions = {
  store: InMemoryStore;
  sourceRegistry: SourceRegistry;
  intervalSeconds?: number | undefined;
  days?: number | undefined;
  logger?: SyncLogger | undefined;
};

export type ProviderSyncStatus = {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  days: number;
  providers: string[];
  lastRunStartedAt?: string | undefined;
  lastRunCompletedAt?: string | undefined;
  lastRun?: ProviderSyncRunSummary | undefined;
};

export type ProviderSyncRunSummary = {
  providers: ProviderSyncProviderSummary[];
  fetchedFixtures: number;
  persistedFixtures: number;
  createdMarkets: number;
  updatedMarkets: number;
  onChainCreatedMarkets: number;
  onChainRecoveredMarkets: number;
  onChainSkippedMarkets: number;
  onChainFailedMarkets: number;
  errors: string[];
};

export type ProviderSyncProviderSummary = {
  provider: string;
  status: "success" | "partial_success" | "failed";
  fetchedFixtures: number;
  persistedFixtures: number;
  createdMarkets: number;
  updatedMarkets: number;
  onChainCreatedMarkets: number;
  onChainRecoveredMarkets: number;
  onChainSkippedMarkets: number;
  onChainFailedMarkets: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

export class ProviderSyncWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastRunStartedAt: string | undefined;
  private lastRunCompletedAt: string | undefined;
  private lastRun: ProviderSyncRunSummary | undefined;

  readonly intervalSeconds: number;
  readonly days: number;

  constructor(private readonly options: ProviderSyncWorkerOptions) {
    this.intervalSeconds = options.intervalSeconds ?? env.SYNC_POLL_INTERVAL_SECONDS;
    this.days = options.days ?? env.SYNC_CURRENT_FIXTURE_DAYS;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalSeconds * 1000);
    this.timer.unref();

    void this.runOnce();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): ProviderSyncStatus {
    return {
      enabled: Boolean(this.timer),
      running: this.running,
      intervalSeconds: this.intervalSeconds,
      days: this.days,
      providers: this.options.sourceRegistry.listProviders(),
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunCompletedAt: this.lastRunCompletedAt,
      lastRun: this.lastRun
    };
  }

  async runOnce(provider?: string | undefined): Promise<ProviderSyncRunSummary> {
    if (this.running) {
      return emptyRun(["Provider sync worker is already running"]);
    }

    this.running = true;
    this.lastRunStartedAt = new Date().toISOString();

    try {
      const providers = provider ? [provider] : this.options.sourceRegistry.listProviders();
      const summaries: ProviderSyncProviderSummary[] = [];

      for (const currentProvider of providers) {
        summaries.push(await this.syncProvider(currentProvider));
      }

      const summary = {
        providers: summaries,
        fetchedFixtures: sum(summaries, "fetchedFixtures"),
        persistedFixtures: sum(summaries, "persistedFixtures"),
        createdMarkets: sum(summaries, "createdMarkets"),
        updatedMarkets: sum(summaries, "updatedMarkets"),
        onChainCreatedMarkets: sum(summaries, "onChainCreatedMarkets"),
        onChainRecoveredMarkets: sum(summaries, "onChainRecoveredMarkets"),
        onChainSkippedMarkets: sum(summaries, "onChainSkippedMarkets"),
        onChainFailedMarkets: sum(summaries, "onChainFailedMarkets"),
        errors: summaries.flatMap((item) => item.errors)
      };

      this.lastRun = summary;
      return summary;
    } finally {
      this.running = false;
      this.lastRunCompletedAt = new Date().toISOString();
      this.logInfo("Provider sync worker completed run", this.lastRun);
    }
  }

  async syncProvider(provider: string): Promise<ProviderSyncProviderSummary> {
    const startedAt = new Date().toISOString();
    const baseSummary = {
      provider,
      fetchedFixtures: 0,
      persistedFixtures: 0,
      createdMarkets: 0,
      updatedMarkets: 0,
      onChainCreatedMarkets: 0,
      onChainRecoveredMarkets: 0,
      onChainSkippedMarkets: 0,
      onChainFailedMarkets: 0,
      errors: [] as string[],
      startedAt,
      finishedAt: startedAt
    };

    try {
      const source = this.options.sourceRegistry.get(provider);
      const { fixtures, errors } = await this.currentFixtures(provider);
      const markets = fixtures
        .flatMap((fixture) => createMarketsForFixture(fixture))
        .map((market) => preserveTerminalMarketStatus(market, this.options.store.getMarket(market.id)));
      const existingMarketIds = new Set(this.options.store.listMarkets().map((market) => market.id));

      this.options.store.upsertFixtures(fixtures);
      await this.options.store.waitForPendingWrites();
      this.options.store.upsertMarkets(markets);
      await this.options.store.waitForPendingWrites();
      const onChain = await this.createMarketsOnChain([
        ...markets,
        ...currentEligiblePlayerFutureMarkets(this.options.store.listMarkets())
      ]);

      const createdMarkets = markets.filter((market) => !existingMarketIds.has(market.id)).length;
      const summaryErrors = [...errors, ...onChain.errors];
      const status: ProviderSyncProviderSummary["status"] = summaryErrors.length > 0 ? "partial_success" : "success";
      const summary = {
        ...baseSummary,
        status,
        fetchedFixtures: fixtures.length,
        persistedFixtures: fixtures.length,
        createdMarkets,
        updatedMarkets: markets.length - createdMarkets,
        ...onChain.counts,
        errors: summaryErrors,
        finishedAt: new Date().toISOString()
      };

      this.options.store.upsertProviderSyncLog({
        provider: source.provider,
        jobType: "current-fixtures",
        status: summary.status,
        startedAt,
        finishedAt: summary.finishedAt,
        details: summary
      });
      await this.options.store.waitForPendingWrites();

      return summary;
    } catch (error) {
      const summary = {
        ...baseSummary,
        status: "failed" as const,
        errors: [errorMessage(error)],
        finishedAt: new Date().toISOString()
      };

      this.options.store.upsertProviderSyncLog({
        provider,
        jobType: "current-fixtures",
        status: summary.status,
        startedAt,
        finishedAt: summary.finishedAt,
        details: summary
      });
      await this.options.store.waitForPendingWrites();

      return summary;
    }
  }

  private async currentFixtures(provider: string): Promise<{ fixtures: Fixture[]; errors: string[] }> {
    const sport = defaultSportForProvider(provider);
    const dates = currentDateWindow(syncDaysForProvider(provider, this.days));
    const dateQueries = rangeFixtureProvider(provider)
      ? [{ from: dates[0]!, to: dates[dates.length - 1]! }]
      : dates.map((date) => ({ from: date }));
    const results = await Promise.all(
      dateQueries.map(async (dateQuery) => {
        const query: FixtureQuery = { ...dateQuery };
        if (sport) query.sport = sport;
        try {
          const fixtures = await this.listFixturesForSync(provider, query);
          return { fixtures, errors: [] as string[] };
        } catch (error) {
          return { fixtures: [] as Fixture[], errors: [`${dateQuery.from}: ${errorMessage(error)}`] };
        }
      })
    );

    const fixtures = uniqueFixtures(results.flatMap((result) => result.fixtures))
      .filter((fixture) => fixture.status === "scheduled" || fixture.status === "live")
      .sort((a, b) => Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime));
    const errors = results.flatMap((result) => result.errors);

    return { fixtures, errors };
  }

  private async listFixturesForSync(provider: string, query: FixtureQuery): Promise<Fixture[]> {
    const source = this.options.sourceRegistry.get(provider);
    const leagueRefs = featuredLeagueRefsForProvider(provider);
    if (leagueRefs.length === 0) return source.listFixtures(query);

    return uniqueFixtures((await Promise.all(leagueRefs.map((leagueRef) =>
      source.listFixtures({
        ...query,
        leagueId: leagueRef.leagueId,
        ...(leagueRef.season ? { season: leagueRef.season } : {})
      })
    ))).flat());
  }

  private async createMarketsOnChain(markets: MarketDefinition[]): Promise<{
    counts: Pick<
      ProviderSyncProviderSummary,
      "onChainCreatedMarkets" | "onChainRecoveredMarkets" | "onChainSkippedMarkets" | "onChainFailedMarkets"
    >;
    errors: string[];
  }> {
    const counts = {
      onChainCreatedMarkets: 0,
      onChainRecoveredMarkets: 0,
      onChainSkippedMarkets: 0,
      onChainFailedMarkets: 0
    };
    const errors: string[] = [];
    const candidates = await this.currentOnChainCandidates(markets);

    if (!env.SYNC_CREATE_MARKETS_ON_CHAIN) {
      counts.onChainSkippedMarkets = candidates.length;
      return { counts, errors };
    }

    const onChainCandidates = candidates.slice(0, env.SYNC_ON_CHAIN_MARKET_LIMIT);
    counts.onChainSkippedMarkets = candidates.length - onChainCandidates.length;

    for (const market of onChainCandidates) {
      try {
        await sleep(env.SYNC_ON_CHAIN_RPC_DELAY_MS);
        const existing = await this.currentCollateralMarketOnChain(market.id);
        const conditionId =
          existing?.conditionId ??
          (await runTrackedOperatorTransaction(this.options.store, {
            action: "CREATE_MARKET",
            entityId: market.id,
            metadata: {
              marketId: market.id,
              marketType: market.type,
              source: "sync"
            },
            execute: (onSubmitted) => createMarketOnChain({
              marketId: market.id,
              marketType: market.type,
              metadataURI: `market:${market.id}`,
              onSubmitted
            })
          })).conditionId;

        if (!conditionId) {
          throw new Error("MarketFactory did not return a conditionId");
        }

        this.options.store.updateMarket({
          ...market,
          conditionId,
          tradingStatus: "open",
          tradingStatusReason: undefined,
          tradingStatusUpdatedAt: new Date().toISOString()
        });

        if (existing) counts.onChainRecoveredMarkets += 1;
        else counts.onChainCreatedMarkets += 1;
      } catch (error) {
        counts.onChainFailedMarkets += 1;
        errors.push(`${market.id}: ${errorMessage(error)}`);
      }
    }

    await this.options.store.waitForPendingWrites();
    return { counts, errors };
  }

  private async currentOnChainCandidates(markets: MarketDefinition[]): Promise<MarketDefinition[]> {
    const openMarkets = uniqueMarkets(markets)
      .filter((market) => market.status === "open")
      .filter((market) => market.tradingStatus !== "closed");
    const missingCondition = openMarkets.filter((market) => !market.conditionId);
    const selected = new Map(missingCondition.map((market) => [market.id, market]));
    const scanLimit = Math.max(env.SYNC_ON_CHAIN_MARKET_LIMIT * 4, env.SYNC_ON_CHAIN_MARKET_LIMIT);

    for (const market of openMarkets.filter((item) => item.conditionId).slice(0, scanLimit)) {
      if (selected.has(market.id)) continue;
      await sleep(env.SYNC_ON_CHAIN_RPC_DELAY_MS);
      const current = await this.currentCollateralMarketOnChain(market.id);
      if (!current) selected.set(market.id, { ...market, conditionId: undefined });
    }

    return [...selected.values()];
  }

  private async currentCollateralMarketOnChain(marketId: string): Promise<OnChainStoredMarket | undefined> {
    const stored = await getMarketOnChain(marketId);
    if (!stored || !env.COLLATERAL_TOKEN_ADDRESS || !env.CONDITIONAL_TOKENS_ADDRESS) return stored;

    const usesCurrentCollateral = await marketUsesCurrentCollateral(
      createPublicChainClient(),
      requireAddress(env.CONDITIONAL_TOKENS_ADDRESS, "CONDITIONAL_TOKENS_ADDRESS"),
      requireAddress(env.COLLATERAL_TOKEN_ADDRESS, "COLLATERAL_TOKEN_ADDRESS"),
      stored
    );

    return usesCurrentCollateral ? stored : undefined;
  }

  private logInfo(message: string, data: unknown): void {
    this.options.logger?.info(message, data);
  }
}

export function createProviderSyncWorker(options: ProviderSyncWorkerOptions): ProviderSyncWorker {
  return new ProviderSyncWorker(options);
}

function createMarketsForFixture(fixture: Fixture): MarketDefinition[] {
  if (fixture.sport === "football") return createFootballFixtureMarkets(fixture as FootballFixture, { status: "open" });
  if (fixture.sport === "basketball") return createBasketballFixtureMarkets(fixture as BasketballFixture, { status: "open" });
  if (fixture.sport === "mma") return createMmaFixtureMarkets(fixture as MmaFixture, { status: "open" });
  if (fixture.sport === "esports") return createEsportsFixtureMarkets(fixture as EsportsFixture, { status: "open" });
  return [];
}

function currentEligiblePlayerFutureMarkets(markets: MarketDefinition[]): MarketDefinition[] {
  const currentYear = new Date().getUTCFullYear();
  return markets
    .filter((market) => market.status === "open")
    .filter((market) => market.tradingStatus !== "closed")
    .filter((market) => market.template?.category === "PLAYER_FUTURE")
    .filter((market) => {
      if (market.template?.category !== "PLAYER_FUTURE") return false;
      const season = Number(market.template.competition.season);
      return !Number.isFinite(season) || season >= currentYear;
    });
}

function preserveTerminalMarketStatus(next: MarketDefinition, current: MarketDefinition | undefined): MarketDefinition {
  if (!current) return next;

  const isTerminal = current.status === "closed" || current.status === "resolved" || current.status === "cancelled";

  return {
    ...next,
    ...(current.conditionId ? { conditionId: current.conditionId } : {}),
    ...(isTerminal ? { tradingStatus: current.tradingStatus } : {}),
    ...(isTerminal ? { status: current.status } : {}),
    ...(current.tradingStatusReason ? { tradingStatusReason: current.tradingStatusReason } : {}),
    ...(current.tradingStatusUpdatedAt ? { tradingStatusUpdatedAt: current.tradingStatusUpdatedAt } : {})
  } as MarketDefinition;
}

function defaultSportForProvider(provider: string): Sport | undefined {
  if (provider === "api-football") return "football";
  if (provider === "api-mma") return "mma";
  if (provider === "highlightly") return "basketball";
  if (provider === "pandascore") return "esports";
  return undefined;
}

function rangeFixtureProvider(provider: string): boolean {
  return provider === "api-football" || provider === "api-mma" || provider === "pandascore";
}

function syncDaysForProvider(provider: string, defaultDays: number): number {
  return provider === "api-football" ? env.API_FOOTBALL_SYNC_FIXTURE_DAYS : defaultDays;
}

function featuredLeagueRefsForProvider(provider: string): { leagueId: string; season?: string | undefined }[] {
  if (provider !== "api-football") return [];
  return env.API_FOOTBALL_FEATURED_LEAGUE_IDS.split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const [leagueId, season] = raw.split(":");
      return {
        leagueId: leagueId?.trim() ?? "",
        ...(season?.trim() ? { season: season.trim() } : {})
      };
    })
    .filter((ref) => Boolean(ref.leagueId));
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

function uniqueFixtures(fixtures: Fixture[]): Fixture[] {
  const byId = new Map<string, Fixture>();
  for (const fixture of fixtures) {
    byId.set(fixture.id, fixture);
  }
  return [...byId.values()];
}

function uniqueMarkets(markets: MarketDefinition[]): MarketDefinition[] {
  const byId = new Map<string, MarketDefinition>();
  for (const market of markets) {
    byId.set(market.id, market);
  }
  return [...byId.values()];
}

function sum<T extends ProviderSyncProviderSummary>(
  items: T[],
  key: keyof Pick<
    T,
    | "fetchedFixtures"
    | "persistedFixtures"
    | "createdMarkets"
    | "updatedMarkets"
    | "onChainCreatedMarkets"
    | "onChainRecoveredMarkets"
    | "onChainSkippedMarkets"
    | "onChainFailedMarkets"
  >
): number {
  return items.reduce((total, item) => total + item[key], 0);
}

function emptyRun(errors: string[]): ProviderSyncRunSummary {
  return {
    providers: [],
    fetchedFixtures: 0,
    persistedFixtures: 0,
    createdMarkets: 0,
    updatedMarkets: 0,
    onChainCreatedMarkets: 0,
    onChainRecoveredMarkets: 0,
    onChainSkippedMarkets: 0,
    onChainFailedMarkets: 0,
    errors
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
