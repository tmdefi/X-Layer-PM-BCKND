import { env } from "../config/env.js";
import { hashIdentifier, outcomeSideToResolverOutcome, resolveMarketOnChain } from "../chain/index.js";
import { computeResolutionDecision } from "../markets/resolution.js";
import type {
  FixtureStatus,
  MarketDefinition,
  ProviderFixtureResult,
  ResolutionDecision
} from "../markets/types.js";
import type { InMemoryStore } from "../api/store.js";
import type { SourceRegistry } from "../sources/index.js";

type SettlementLogger = {
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
};

export type SettlementWorkerOptions = {
  store: InMemoryStore;
  sourceRegistry: SourceRegistry;
  intervalSeconds?: number | undefined;
  submitOnChain?: boolean | undefined;
  logger?: SettlementLogger | undefined;
};

export type SettlementWorkerStatus = {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  submitOnChain: boolean;
  trackedLiveFixtures: number;
  lastRunStartedAt?: string | undefined;
  lastRunCompletedAt?: string | undefined;
  lastRun?: SettlementRunSummary | undefined;
};

export type SettlementRunSummary = {
  checkedFixtures: number;
  checkedMarkets: number;
  liveFixtures: number;
  liveTransitions: number;
  computedResolutions: number;
  submittedOnChain: number;
  skippedMarkets: number;
  errors: string[];
};

type SettlementGroup = {
  fixtureId: string;
  provider: string;
  externalFixtureId: string;
  markets: MarketDefinition[];
};

const SETTLEMENT_STATUSES: FixtureStatus[] = ["finished", "cancelled", "abandoned", "postponed"];

export class SettlementWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly liveFixtureKeys = new Set<string>();
  private lastRunStartedAt: string | undefined;
  private lastRunCompletedAt: string | undefined;
  private lastRun: SettlementRunSummary | undefined;

  readonly intervalSeconds: number;
  readonly submitOnChain: boolean;

  constructor(private readonly options: SettlementWorkerOptions) {
    this.intervalSeconds = options.intervalSeconds ?? env.SETTLEMENT_POLL_INTERVAL_SECONDS;
    this.submitOnChain = options.submitOnChain ?? env.SETTLEMENT_SUBMIT_ON_CHAIN;
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

  status(): SettlementWorkerStatus {
    return {
      enabled: Boolean(this.timer),
      running: this.running,
      intervalSeconds: this.intervalSeconds,
      submitOnChain: this.submitOnChain,
      trackedLiveFixtures: this.liveFixtureKeys.size,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunCompletedAt: this.lastRunCompletedAt,
      lastRun: this.lastRun
    };
  }

  async runOnce(): Promise<SettlementRunSummary> {
    if (this.running) {
      return {
        checkedFixtures: 0,
        checkedMarkets: 0,
        liveFixtures: 0,
        liveTransitions: 0,
        computedResolutions: 0,
        submittedOnChain: 0,
        skippedMarkets: 0,
        errors: ["Settlement worker is already running"]
      };
    }

    this.running = true;
    this.lastRunStartedAt = new Date().toISOString();

    const summary: SettlementRunSummary = {
      checkedFixtures: 0,
      checkedMarkets: 0,
      liveFixtures: 0,
      liveTransitions: 0,
      computedResolutions: 0,
      submittedOnChain: 0,
      skippedMarkets: 0,
      errors: []
    };

    try {
      const groups = this.marketGroups();
      const currentLiveFixtureKeys = await this.refreshLiveFixtures(groups, summary);
      const transitionGroups = groups.filter(
        (group) => this.liveFixtureKeys.has(liveKey(group.provider, group.externalFixtureId)) &&
          !currentLiveFixtureKeys.has(liveKey(group.provider, group.externalFixtureId))
      );

      summary.liveTransitions = transitionGroups.length;
      const transitionedKeys = new Set(transitionGroups.map((group) => groupKey(group)));

      for (const group of transitionGroups) {
        await this.settleGroup(group, summary);
      }

      this.liveFixtureKeys.clear();
      for (const key of currentLiveFixtureKeys) {
        this.liveFixtureKeys.add(key);
      }

      for (const group of groups) {
        if (transitionedKeys.has(groupKey(group))) continue;
        if (this.liveFixtureKeys.has(liveKey(group.provider, group.externalFixtureId))) {
          summary.skippedMarkets += group.markets.length;
          continue;
        }

        await this.settleGroup(group, summary);
      }
    } finally {
      this.running = false;
      this.lastRunCompletedAt = new Date().toISOString();
      this.lastRun = summary;
      this.logInfo("Settlement worker completed run", summary);
    }

    return summary;
  }

  private async settleMarket(
    market: MarketDefinition,
    result: ProviderFixtureResult,
    summary: SettlementRunSummary
  ): Promise<void> {
    try {
      const decision =
        result.status === "finished"
          ? computeResolutionDecision(market, result)
          : createVoidDecision(market, result);

      this.options.store.upsertResolution(decision);
      this.options.store.updateMarket({
        ...market,
        status: decision.outcome === "VOID" ? "cancelled" : "resolved"
      });
      summary.computedResolutions += 1;

      if (this.submitOnChain && decision.outcome !== "VOID") {
        await resolveMarketOnChain(hashIdentifier(market.id), outcomeSideToResolverOutcome(decision.outcome));
        this.options.store.upsertResolution({
          ...decision,
          status: "submitted"
        });
        summary.submittedOnChain += 1;
      }
    } catch (error) {
      summary.errors.push(errorMessage(error));
    }
  }

  private async settleGroup(group: SettlementGroup, summary: SettlementRunSummary): Promise<void> {
    summary.checkedFixtures += 1;
    summary.checkedMarkets += group.markets.length;

    try {
      const result = await this.options.sourceRegistry
        .get(group.provider)
        .getFixtureResult(group.externalFixtureId);

      if (!SETTLEMENT_STATUSES.includes(result.status)) {
        summary.skippedMarkets += group.markets.length;
        return;
      }

      for (const market of group.markets) {
        await this.settleMarket(market, result, summary);
      }
    } catch (error) {
      summary.errors.push(errorMessage(error));
    }
  }

  private async refreshLiveFixtures(
    groups: SettlementGroup[],
    summary: SettlementRunSummary
  ): Promise<Set<string>> {
    const liveKeys = new Set<string>();
    const providers = [...new Set(groups.map((group) => group.provider))];
    const featuredLiveKeys = new Set(groups.map((group) => liveKey(group.provider, group.externalFixtureId)));

    for (const provider of providers) {
      try {
        const source = this.options.sourceRegistry.get(provider);
        if (!source.listLiveFixtures) continue;

        const fixtures = await source.listLiveFixtures();

        for (const fixture of fixtures) {
          const externalFixtureId = fixture.source.externalFixtureId;
          if (!externalFixtureId) continue;

          const key = liveKey(provider, externalFixtureId);
          if (!featuredLiveKeys.has(key)) continue;

          this.options.store.upsertFixture({
            ...fixture,
            status: "live"
          });

          liveKeys.add(key);
        }
      } catch (error) {
        summary.errors.push(errorMessage(error));
      }
    }

    summary.liveFixtures = liveKeys.size;
    return liveKeys;
  }

  private marketGroups(): SettlementGroup[] {
    const groups = new Map<string, SettlementGroup>();

    for (const market of this.options.store.listMarkets()) {
      if (!market.fixtureId || market.status === "resolved" || market.status === "cancelled") continue;

      const existingResolution = this.options.store.getResolution(market.id);
      if (existingResolution?.status === "computed" || existingResolution?.status === "reviewed") continue;
      if (existingResolution?.status === "submitted") continue;

      const source = market.resolver?.source ?? market.source;
      if (!source?.provider || !source.externalFixtureId) continue;

      const key = `${source.provider}:${source.externalFixtureId}:${market.fixtureId}`;
      const group =
        groups.get(key) ??
        {
          fixtureId: market.fixtureId,
          provider: source.provider,
          externalFixtureId: source.externalFixtureId,
          markets: []
        };

      group.markets.push(market);
      groups.set(key, group);
    }

    return [...groups.values()];
  }

  private logInfo(message: string, data: unknown): void {
    this.options.logger?.info(message, data);
  }
}

function liveKey(provider: string, externalFixtureId: string): string {
  return `${provider}:${externalFixtureId}`;
}

function groupKey(group: SettlementGroup): string {
  return `${group.fixtureId}:${group.provider}:${group.externalFixtureId}`;
}

export function createSettlementWorker(options: SettlementWorkerOptions): SettlementWorker {
  return new SettlementWorker(options);
}

function createVoidDecision(
  market: MarketDefinition,
  result: ProviderFixtureResult,
  computedAt = new Date().toISOString()
): ResolutionDecision {
  return {
    marketId: market.id,
    marketType: market.type,
    outcome: "VOID",
    payoutVector: [1, 1],
    status: "computed",
    source: result.source,
    observedAt: result.observedAt,
    computedAt,
    reason: `Fixture status ${result.status}: market void/refund`
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
