import { env } from "../config/env.js";
import type { Fixture, FixtureStatus, ProviderFixtureResult } from "../markets/types.js";
import type { FixtureQuery, MarketDataSource } from "./types.js";

type PandaScoreOpponent = {
  opponent: {
    id: number;
    name: string;
    image_url?: string | null;
  };
};

type PandaScoreResult = {
  opponent_id: number;
  score: number;
};

type PandaScoreMatch = {
  id: number;
  name: string;
  begin_at: string | null;
  status: string;
  opponents: PandaScoreOpponent[];
  results: PandaScoreResult[];
  winner_id: number | null;
  videogame?: {
    name?: string | null;
  } | null;
  league?: {
    name?: string | null;
  } | null;
  tournament?: {
    name?: string | null;
  } | null;
};

export class PandaScoreSource implements MarketDataSource {
  readonly provider = "pandascore";

  constructor(
    private readonly token: string,
    private readonly baseUrl = env.PANDASCORE_BASE_URL
  ) {}

  async listFixtures(query: FixtureQuery): Promise<Fixture[]> {
    if (query.sport && query.sport !== "esports") {
      return [];
    }

    if (query.externalFixtureId) {
      return [this.toFixture(await this.getMatch(query.externalFixtureId))].filter(isFixture);
    }

    const params = new URLSearchParams({
      sort: "begin_at",
      "page[size]": "100"
    });

    const [runningMatches, upcomingMatches] = await Promise.all([
      this.request<PandaScoreMatch[]>("/matches/running", params),
      this.request<PandaScoreMatch[]>("/matches/upcoming", params)
    ]);

    return [...runningMatches, ...upcomingMatches]
      .map((match) => this.toFixture(match))
      .filter(isFixture)
      .filter((fixture) => inDateWindow(fixture, query))
      .sort((a, b) => Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime));
  }

  async listLiveFixtures(): Promise<Fixture[]> {
    const matches = await this.request<PandaScoreMatch[]>(
      "/matches/running",
      new URLSearchParams({
        sort: "begin_at",
        "page[size]": "100"
      })
    );

    return matches.map((match) => this.toFixture(match)).filter(isFixture);
  }

  async getFixtureResult(externalFixtureId: string): Promise<ProviderFixtureResult> {
    const match = await this.getMatch(externalFixtureId);
    const fixture = this.toFixture(match);
    if (!fixture) {
      throw new Error(`PandaScore match is missing two opponents: ${externalFixtureId}`);
    }

    const result: ProviderFixtureResult = {
      source: {
        provider: this.provider,
        externalFixtureId: String(match.id),
        sourceUrl: `${this.baseUrl}/matches/${match.id}`,
        fetchedAt: new Date().toISOString()
      },
      fixtureId: fixture.id,
      status: mapMatchStatus(match.status),
      observedAt: new Date().toISOString()
    };

    const [homeOpponent, awayOpponent] = match.opponents;
    if (homeOpponent && awayOpponent && match.winner_id !== null) {
      result.explicitOutcome = match.winner_id === homeOpponent.opponent.id ? "YES" : "NO";
    }

    const homeScore = scoreForOpponent(match.results, homeOpponent?.opponent.id);
    const awayScore = scoreForOpponent(match.results, awayOpponent?.opponent.id);
    if (homeScore !== undefined && awayScore !== undefined) {
      result.score = {
        homeGoals: homeScore,
        awayGoals: awayScore
      };
    }

    return result;
  }

  private async getMatch(externalFixtureId: string): Promise<PandaScoreMatch> {
    return this.request<PandaScoreMatch>(`/matches/${externalFixtureId}`, new URLSearchParams());
  }

  private async request<T>(path: string, params: URLSearchParams): Promise<T> {
    if (!this.token) {
      throw new Error("PANDASCORE_TOKEN is required to use PandaScore");
    }

    const url = new URL(path, this.baseUrl);
    url.search = params.toString();

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      throw new Error(`PandaScore request failed with ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as T;
  }

  private toFixture(match: PandaScoreMatch): Fixture | undefined {
    const [homeOpponent, awayOpponent] = match.opponents;
    if (!homeOpponent || !awayOpponent) return undefined;

    const fixture: Fixture = {
      id: this.fixtureId(match.id),
      sport: "esports",
      source: {
        provider: this.provider,
        externalFixtureId: String(match.id),
        sourceUrl: `${this.baseUrl}/matches/${match.id}`,
        fetchedAt: new Date().toISOString()
      },
      homeCompetitor: homeOpponent.opponent.name,
      awayCompetitor: awayOpponent.opponent.name,
      ...(homeOpponent.opponent.image_url ? { homeLogoUrl: homeOpponent.opponent.image_url } : {}),
      ...(awayOpponent.opponent.image_url ? { awayLogoUrl: awayOpponent.opponent.image_url } : {}),
      kickoffTime: match.begin_at ?? new Date(0).toISOString(),
      status: mapMatchStatus(match.status)
    };

    return fixture;
  }

  private fixtureId(externalFixtureId: number): string {
    return `pandascore:${externalFixtureId}`;
  }
}

export function createPandaScoreSource(): PandaScoreSource | undefined {
  if (!env.PANDASCORE_TOKEN) {
    return undefined;
  }

  return new PandaScoreSource(env.PANDASCORE_TOKEN);
}

function mapMatchStatus(status: string): FixtureStatus {
  switch (status) {
    case "not_started":
      return "scheduled";
    case "running":
      return "live";
    case "finished":
      return "finished";
    case "canceled":
      return "cancelled";
    default:
      return "scheduled";
  }
}

function scoreForOpponent(results: PandaScoreResult[], opponentId: number | undefined): number | undefined {
  if (opponentId === undefined) return undefined;
  return results.find((result) => result.opponent_id === opponentId)?.score;
}

function isFixture(fixture: Fixture | undefined): fixture is Fixture {
  return Boolean(fixture);
}

function inDateWindow(fixture: Fixture, query: FixtureQuery): boolean {
  const kickoffTime = Date.parse(fixture.kickoffTime);
  if (query.from && kickoffTime < Date.parse(query.from)) return false;
  if (query.to && kickoffTime > Date.parse(query.to)) return false;
  return true;
}
