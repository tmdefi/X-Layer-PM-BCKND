import { env } from "../config/env.js";
import type { Fixture, FixtureStatus, ProviderFixtureResult, Score, TennisFixture } from "../markets/types.js";
import type { FixtureQuery, MarketDataSource } from "./types.js";

type OddsApiEvent = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
};

type OddsApiScore = OddsApiEvent & {
  completed: boolean;
  scores?: { name: string; score: string }[] | null;
  last_update?: string | null;
};

export class TheOddsApiSource implements MarketDataSource {
  readonly provider = "the-odds-api";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = env.THE_ODDS_API_BASE_URL
  ) {}

  async listFixtures(query: FixtureQuery): Promise<Fixture[]> {
    if (query.sport && query.sport !== "tennis") {
      return [];
    }

    if (query.externalFixtureId) {
      const parsed = parseExternalFixtureId(query.externalFixtureId);
      if (!parsed) return [];
      const [event] = await this.events(parsed.sportKey, query, parsed.eventId);
      return event ? [this.toFixture(event)] : [];
    }

    const sportKeys = query.leagueId ? [query.leagueId] : tennisSportKeys();
    const fixtures = (await Promise.all(sportKeys.map((sportKey) => this.events(sportKey, query))))
      .flat()
      .map((event) => this.toFixture(event))
      .filter((fixture) => knownCompetitor(fixture.homeCompetitor) && knownCompetitor(fixture.awayCompetitor))
      .sort((a, b) => Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime));

    return uniqueFixtures(fixtures).slice(0, env.THE_ODDS_API_TENNIS_SYNC_FIXTURE_LIMIT);
  }

  async listLiveFixtures(): Promise<Fixture[]> {
    const now = new Date().toISOString();
    const fixtures = await this.listFixtures({ sport: "tennis", to: now.slice(0, 10) });
    return fixtures.filter((fixture) => fixture.status === "live");
  }

  async getFixtureResult(externalFixtureId: string): Promise<ProviderFixtureResult> {
    const parsed = parseExternalFixtureId(externalFixtureId);
    if (!parsed) {
      throw new Error(`Invalid The Odds API tennis fixture id: ${externalFixtureId}`);
    }

    const [scoreEvent] = await this.request<OddsApiScore[]>(
      `/sports/${encodeURIComponent(parsed.sportKey)}/scores`,
      new URLSearchParams({
        daysFrom: "3",
        eventIds: parsed.eventId
      })
    );

    if (!scoreEvent) {
      const [event] = await this.events(parsed.sportKey, {}, parsed.eventId);
      if (!event) throw new Error(`The Odds API event ${parsed.eventId} was not found`);
      return {
        source: sourceRef(this.provider, this.baseUrl, event),
        fixtureId: fixtureId(this.provider, event.sport_key, event.id),
        status: mapEventStatus(event.commence_time),
        observedAt: new Date().toISOString()
      };
    }

    const result: ProviderFixtureResult = {
      source: sourceRef(this.provider, this.baseUrl, scoreEvent),
      fixtureId: fixtureId(this.provider, scoreEvent.sport_key, scoreEvent.id),
      status: scoreEvent.completed ? "finished" : mapEventStatus(scoreEvent.commence_time),
      observedAt: new Date().toISOString()
    };

    const score = eventScore(scoreEvent);
    if (score) {
      result.score = score;
    }

    return result;
  }

  private async events(sportKey: string, query: FixtureQuery, eventId?: string): Promise<OddsApiEvent[]> {
    const params = new URLSearchParams();
    if (query.from) params.set("commenceTimeFrom", `${query.from}T00:00:00Z`);
    if (query.to) params.set("commenceTimeTo", `${query.to}T23:59:59Z`);
    if (eventId) params.set("eventIds", eventId);

    return await this.request<OddsApiEvent[]>(`/sports/${encodeURIComponent(sportKey)}/events`, params);
  }

  private async request<T>(path: string, params?: URLSearchParams): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${path}`);
    url.searchParams.set("apiKey", this.apiKey);
    if (params) {
      for (const [key, value] of params) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`the-odds-api request failed with ${response.status}: ${body || response.statusText}`);
    }

    return await response.json() as T;
  }

  private toFixture(event: OddsApiEvent): TennisFixture {
    return {
      id: fixtureId(this.provider, event.sport_key, event.id),
      sport: "tennis",
      source: sourceRef(this.provider, this.baseUrl, event),
      competition: {
        kind: "tournament",
        id: event.sport_key,
        name: event.sport_title
      },
      homeCompetitor: event.home_team,
      awayCompetitor: event.away_team,
      kickoffTime: new Date(event.commence_time).toISOString(),
      status: mapEventStatus(event.commence_time),
      tournamentKey: event.sport_key
    };
  }
}

export function createTheOddsApiSource(): TheOddsApiSource | undefined {
  if (!env.THE_ODDS_API_KEY) {
    return undefined;
  }

  return new TheOddsApiSource(env.THE_ODDS_API_KEY);
}

function tennisSportKeys(): string[] {
  return env.THE_ODDS_API_TENNIS_SPORT_KEYS
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

function sourceRef(provider: string, baseUrl: string, event: OddsApiEvent) {
  return {
    provider,
    externalFixtureId: `${event.sport_key}:${event.id}`,
    sourceUrl: `${baseUrl.replace(/\/$/, "")}/sports/${encodeURIComponent(event.sport_key)}/events?eventIds=${encodeURIComponent(event.id)}`,
    fetchedAt: new Date().toISOString()
  };
}

function fixtureId(provider: string, sportKey: string, eventId: string): string {
  return `${provider}:${sportKey}:${eventId}`;
}

function parseExternalFixtureId(externalFixtureId: string): { sportKey: string; eventId: string } | undefined {
  const separator = externalFixtureId.indexOf(":");
  if (separator <= 0 || separator === externalFixtureId.length - 1) {
    return undefined;
  }

  return {
    sportKey: externalFixtureId.slice(0, separator),
    eventId: externalFixtureId.slice(separator + 1)
  };
}

function mapEventStatus(commenceTime: string): FixtureStatus {
  const time = Date.parse(commenceTime);
  if (Number.isNaN(time)) return "scheduled";
  return time <= Date.now() ? "live" : "scheduled";
}

function eventScore(event: OddsApiScore): Score | undefined {
  const scores = event.scores ?? [];
  const homeScore = scoreForTeam(scores, event.home_team);
  const awayScore = scoreForTeam(scores, event.away_team);
  if (homeScore === undefined || awayScore === undefined) return undefined;

  return {
    homeGoals: homeScore,
    awayGoals: awayScore
  };
}

function scoreForTeam(scores: { name: string; score: string }[], team: string): number | undefined {
  const found = scores.find((score) => normalize(score.name) === normalize(team));
  if (!found) return undefined;
  const numeric = Number.parseFloat(found.score);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function knownCompetitor(name: string): boolean {
  const normalized = normalize(name);
  return Boolean(normalized) && !["tbc", "tbd", "to be confirmed", "unknown"].includes(normalized);
}

function uniqueFixtures(fixtures: TennisFixture[]): TennisFixture[] {
  const byId = new Map<string, TennisFixture>();
  for (const fixture of fixtures) {
    byId.set(fixture.id, fixture);
  }
  return [...byId.values()];
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
