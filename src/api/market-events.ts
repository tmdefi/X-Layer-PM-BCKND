import { randomUUID } from "node:crypto";
import type {
  Fixture,
  MarketDefinition,
  OutcomeSide,
  ResolutionDecision,
  Score
} from "../markets/types.js";

type MarketEventBase = {
  id: string;
  at: string;
};

export type MarketRealtimeEvent =
  | (MarketEventBase & {
      type: "stream.connected";
    })
  | (MarketEventBase & {
      type: "market.created";
      market: MarketDefinition;
    })
  | (MarketEventBase & {
      type: "market.trading_status_changed";
      marketId: string;
      status: MarketDefinition["status"];
      tradingStatus: MarketDefinition["tradingStatus"];
      reason?: string | undefined;
    })
  | (MarketEventBase & {
      type: "market.early_resolution_candidate";
      marketId: string;
      resolution: ResolutionDecision;
    })
  | (MarketEventBase & {
      type: "market.resolution_submitted";
      marketId: string;
      resolution: ResolutionDecision;
    })
  | (MarketEventBase & {
      type: "market.redeemable";
      marketId: string;
      winningOutcome: OutcomeSide;
      resolution: ResolutionDecision;
    })
  | (MarketEventBase & {
      type: "fixture.status_changed";
      fixtureId: string;
      fixture: Fixture;
    })
  | (MarketEventBase & {
      type: "fixture.live_score_updated";
      fixtureId: string;
      score: Score;
      observedAt: string;
      source: Fixture["source"];
    });

type MarketRealtimeInput<T> = T extends MarketRealtimeEvent
  ? Omit<T, "id" | "at"> & { at?: string | undefined }
  : never;

export type MarketRealtimeEventInput = MarketRealtimeInput<MarketRealtimeEvent>;

type MarketRealtimeListener = (event: MarketRealtimeEvent) => void;

export class MarketEventHub {
  private readonly listeners = new Set<MarketRealtimeListener>();

  subscribe(listener: MarketRealtimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(input: MarketRealtimeEventInput): MarketRealtimeEvent {
    const event = {
      ...input,
      id: randomUUID(),
      at: input.at ?? new Date().toISOString()
    } as MarketRealtimeEvent;

    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }
}
