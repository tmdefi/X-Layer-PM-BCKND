import { env } from "../config/env.js";
import { hashIdentifier, outcomeSideToResolverOutcome, resolveMarketOnChain } from "../chain/index.js";
import {
  computeEarlyResolutionDecision,
  computeResolutionDecision,
  confirmEarlyResolutionDecision
} from "../markets/resolution.js";
import { footballLiveTradingCloseReason } from "../markets/live-trading.js";
import type {
  FixtureStatus,
  MarketDefinition,
  ProviderFixtureResult,
  ResolutionDecision
} from "../markets/types.js";
import type { InMemoryStore } from "../api/store.js";
import { runTrackedOperatorTransaction } from "../api/operator-transactions.js";
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
  nearKickoffWindowMinutes?: number | undefined;
  nearKickoffFallbackIntervalSeconds?: number | undefined;
  providerLimits?: Partial<Record<string, ProviderSettlementLimit>> | undefined;
  logger?: SettlementLogger | undefined;
};

type ProviderSettlementLimit = {
  maxFixturesPerRun: number;
  cooldownSeconds: number;
};

export type SettlementWorkerStatus = {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  submitOnChain: boolean;
  nearKickoffWindowMinutes: number;
  nearKickoffFallbackIntervalSeconds: number;
  providerLimits: Record<string, ProviderSettlementLimit>;
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
  closedLiveMarkets: number;
  earlyResolutions: number;
  scheduledFallbackChecks: number;
  deferredScheduledMarkets: number;
  submittedOnChain: number;
  skippedMarkets: number;
  rateLimitedFixtures: number;
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
  private readonly scheduledFallbackChecks = new Map<string, number>();
  private readonly providerLastCheckedAt = new Map<string, number>();
  private readonly providerLastLiveListAt = new Map<string, number>();
  private lastRunStartedAt: string | undefined;
  private lastRunCompletedAt: string | undefined;
  private lastRun: SettlementRunSummary | undefined;

  readonly intervalSeconds: number;
  readonly submitOnChain: boolean;
  readonly nearKickoffWindowMinutes: number;
  readonly nearKickoffFallbackIntervalSeconds: number;
  readonly providerLimits: Record<string, ProviderSettlementLimit>;

  constructor(private readonly options: SettlementWorkerOptions) {
    this.intervalSeconds = options.intervalSeconds ?? env.SETTLEMENT_POLL_INTERVAL_SECONDS;
    this.submitOnChain = options.submitOnChain ?? env.SETTLEMENT_SUBMIT_ON_CHAIN;
    this.nearKickoffWindowMinutes =
      options.nearKickoffWindowMinutes ?? env.SETTLEMENT_NEAR_KICKOFF_WINDOW_MINUTES;
    this.nearKickoffFallbackIntervalSeconds =
      options.nearKickoffFallbackIntervalSeconds ?? env.SETTLEMENT_NEAR_KICKOFF_FALLBACK_INTERVAL_SECONDS;
    this.providerLimits = {
      pandascore: {
        maxFixturesPerRun: env.PANDASCORE_SETTLEMENT_MAX_FIXTURES_PER_RUN,
        cooldownSeconds: env.PANDASCORE_SETTLEMENT_COOLDOWN_SECONDS
      },
      ...(options.providerLimits ?? {})
    };
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
      nearKickoffWindowMinutes: this.nearKickoffWindowMinutes,
      nearKickoffFallbackIntervalSeconds: this.nearKickoffFallbackIntervalSeconds,
      providerLimits: this.providerLimits,
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
        closedLiveMarkets: 0,
        earlyResolutions: 0,
        scheduledFallbackChecks: 0,
        deferredScheduledMarkets: 0,
        submittedOnChain: 0,
        skippedMarkets: 0,
        rateLimitedFixtures: 0,
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
      closedLiveMarkets: 0,
      earlyResolutions: 0,
      scheduledFallbackChecks: 0,
      deferredScheduledMarkets: 0,
      submittedOnChain: 0,
      skippedMarkets: 0,
      rateLimitedFixtures: 0,
      errors: []
    };

    try {
      const groups = this.marketGroups();
      const providerChecks = this.providerCheckTracker();
      const currentLiveFixtureKeys = await this.refreshLiveFixtures(groups, summary);
      const transitionGroups = groups.filter(
        (group) => this.liveFixtureKeys.has(liveKey(group.provider, group.externalFixtureId)) &&
          !currentLiveFixtureKeys.has(liveKey(group.provider, group.externalFixtureId))
      );

      summary.liveTransitions = transitionGroups.length;
      const transitionedKeys = new Set(transitionGroups.map((group) => groupKey(group)));

      for (const group of transitionGroups) {
        if (!this.canCheckProviderGroup(group, providerChecks, summary)) continue;
        await this.settleGroup(group, summary);
      }

      this.liveFixtureKeys.clear();
      for (const key of currentLiveFixtureKeys) {
        this.liveFixtureKeys.add(key);
      }

      for (const group of groups) {
        if (transitionedKeys.has(groupKey(group))) continue;
        if (this.liveFixtureKeys.has(liveKey(group.provider, group.externalFixtureId))) {
          if (!this.canCheckProviderGroup(group, providerChecks, summary)) continue;
          await this.applyLiveTradingRules(group, summary);
          summary.skippedMarkets += group.markets.length;
          continue;
        }

        if (this.shouldCheckNonLiveGroup(group, summary)) {
          if (!this.canCheckProviderGroup(group, providerChecks, summary)) continue;
          await this.settleGroup(group, summary);
        }
      }
    } finally {
      this.running = false;
      this.lastRunCompletedAt = new Date().toISOString();
      this.lastRun = summary;
      this.logInfo("Settlement worker completed run", summary);
    }

    return summary;
  }

  private providerCheckTracker(): Map<string, number> {
    const tracker = new Map<string, number>();
    const now = Date.now();

    for (const [provider, limit] of Object.entries(this.providerLimits)) {
      const lastCheckedAt = this.providerLastCheckedAt.get(provider);
      if (lastCheckedAt && now - lastCheckedAt < limit.cooldownSeconds * 1000) {
        tracker.set(provider, limit.maxFixturesPerRun);
      }
    }

    return tracker;
  }

  private canCheckProviderGroup(
    group: SettlementGroup,
    providerChecks: Map<string, number>,
    summary: SettlementRunSummary
  ): boolean {
    const limit = this.providerLimits[group.provider];
    if (!limit) return true;

    const checked = providerChecks.get(group.provider) ?? 0;
    if (checked >= limit.maxFixturesPerRun) {
      summary.rateLimitedFixtures += 1;
      summary.deferredScheduledMarkets += group.markets.length;
      return false;
    }

    providerChecks.set(group.provider, checked + 1);
    this.providerLastCheckedAt.set(group.provider, Date.now());
    return true;
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

      await this.storeResolvedMarket(market, decision, summary);
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

  private async applyLiveTradingRules(group: SettlementGroup, summary: SettlementRunSummary): Promise<void> {
    try {
      const result = await this.options.sourceRegistry
        .get(group.provider)
        .getFixtureResult(group.externalFixtureId);

      if (result.status !== "live") return;
      if (result.score) {
        this.options.store.publishMarketEvent({
          type: "fixture.live_score_updated",
          fixtureId: result.fixtureId,
          score: result.score,
          observedAt: result.observedAt,
          source: result.source
        });
      }

      for (const market of group.markets) {
        const observedEarlyDecision = computeEarlyResolutionDecision(market, result);
        if (observedEarlyDecision) {
          const earlyDecision = confirmEarlyResolutionDecision(
            this.options.store.getResolution(market.id),
            observedEarlyDecision
          );
          if (earlyDecision.earlyResolution?.confirmedAt) {
            await this.storeResolvedMarket(market, earlyDecision, summary);
            summary.earlyResolutions += 1;
          } else {
            this.storeEarlyResolutionCandidate(market, earlyDecision);
          }
          continue;
        }

        const reason = footballLiveTradingCloseReason(market, result);
        if (!reason) continue;

        this.options.store.updateMarket({
          ...market,
          tradingStatus: "closed",
          tradingStatusReason: reason,
          tradingStatusUpdatedAt: result.observedAt
        });
        summary.closedLiveMarkets += 1;
      }
    } catch (error) {
      summary.errors.push(errorMessage(error));
    }
  }

  private async storeResolvedMarket(
    market: MarketDefinition,
    decision: ResolutionDecision,
    summary: SettlementRunSummary
  ): Promise<void> {
    this.options.store.upsertResolution(decision);
    this.options.store.updateMarket({
      ...market,
      status: decision.outcome === "VOID" ? "cancelled" : "resolved",
      tradingStatus: "closed",
      tradingStatusReason: decision.outcome === "VOID" ? "Fixture voided" : decision.reason,
      tradingStatusUpdatedAt: decision.computedAt
    });
    summary.computedResolutions += 1;

    if (this.submitOnChain && decision.outcome !== "VOID") {
      const questionId = hashIdentifier(market.id);
      await runTrackedOperatorTransaction(this.options.store, {
        action: "SUBMIT_RESOLUTION",
        entityId: market.id,
        metadata: {
          marketId: market.id,
          outcome: decision.outcome,
          questionId,
          earlyResolution: Boolean(decision.earlyResolution)
        },
        execute: (onSubmitted) => resolveMarketOnChain(
          questionId,
          outcomeSideToResolverOutcome(decision.outcome),
          { onSubmitted }
        )
      });
      this.options.store.upsertResolution({
        ...decision,
        status: "submitted"
      });
      summary.submittedOnChain += 1;
    }
  }

  private storeEarlyResolutionCandidate(market: MarketDefinition, decision: ResolutionDecision): void {
    this.options.store.upsertResolution(decision);
    this.options.store.updateMarket({
      ...market,
      status: market.status === "open" ? "closed" : market.status,
      tradingStatus: "closed",
      tradingStatusReason: `${decision.reason}; awaiting repeated confirmation`,
      tradingStatusUpdatedAt: decision.computedAt
    });
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
        if (!this.canRefreshProviderLiveFixtures(provider)) continue;

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

  private canRefreshProviderLiveFixtures(provider: string): boolean {
    const limit = this.providerLimits[provider];
    if (!limit) return true;

    const now = Date.now();
    const lastCheckedAt = this.providerLastLiveListAt.get(provider);
    if (lastCheckedAt && now - lastCheckedAt < limit.cooldownSeconds * 1000) {
      return false;
    }

    this.providerLastLiveListAt.set(provider, now);
    return true;
  }

  private marketGroups(): SettlementGroup[] {
    const groups = new Map<string, SettlementGroup>();

    for (const market of this.options.store.listMarkets()) {
      if (!market.fixtureId || market.status === "resolved" || market.status === "cancelled") continue;

      const existingResolution = this.options.store.getResolution(market.id);
      if (
        (existingResolution?.status === "computed" || existingResolution?.status === "reviewed") &&
        !existingResolution.earlyResolution
      ) continue;
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

  private shouldCheckNonLiveGroup(group: SettlementGroup, summary: SettlementRunSummary): boolean {
    const fixture = this.options.store.getFixture(group.fixtureId);
    if (!fixture) {
      summary.deferredScheduledMarkets += group.markets.length;
      return false;
    }

    if (SETTLEMENT_STATUSES.includes(fixture.status) || fixture.status === "live") {
      return true;
    }

    if (fixture.status !== "scheduled" || !this.isNearKickoff(fixture.kickoffTime)) {
      summary.deferredScheduledMarkets += group.markets.length;
      return false;
    }

    if (!this.canRunScheduledFallback(group)) {
      summary.deferredScheduledMarkets += group.markets.length;
      return false;
    }

    summary.scheduledFallbackChecks += 1;
    return true;
  }

  private canRunScheduledFallback(group: SettlementGroup): boolean {
    if (this.nearKickoffFallbackIntervalSeconds <= 0) return false;

    const key = groupKey(group);
    const now = Date.now();
    const lastCheck = this.scheduledFallbackChecks.get(key);
    if (lastCheck && now - lastCheck < this.nearKickoffFallbackIntervalSeconds * 1000) {
      return false;
    }

    this.scheduledFallbackChecks.set(key, now);
    return true;
  }

  private isNearKickoff(kickoffTime: string): boolean {
    if (this.nearKickoffWindowMinutes <= 0) return false;

    const kickoff = Date.parse(kickoffTime);
    if (!Number.isFinite(kickoff)) return false;
    return Math.abs(Date.now() - kickoff) <= this.nearKickoffWindowMinutes * 60 * 1000;
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
