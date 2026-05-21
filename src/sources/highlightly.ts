import { env } from "../config/env.js";
import type { Fixture, FixtureStatus, ProviderFixtureResult } from "../markets/types.js";
import type { FixtureQuery, MarketDataSource } from "./types.js";

type HighlightlyTeam = {
  id: number;
  name: string;
  logo?: string | null;
  logoUrl?: string | null;
  image?: string | null;
  imageUrl?: string | null;
};

type HighlightlyScore = {
  total?: number | null;
  [period: string]: number | null | undefined;
};

type HighlightlyMatch = {
  id: number;
  date: string;
  league: string;
  state: {
    description: string;
  };
  homeTeam: HighlightlyTeam;
  awayTeam: HighlightlyTeam;
  homeScore?: HighlightlyScore | null;
  awayScore?: HighlightlyScore | null;
};

type HighlightlyResponse<T> = {
  data?: T[];
};

export class HighlightlySource implements MarketDataSource {
  readonly provider = "highlightly";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = env.HIGHLIGHTLY_BASE_URL,
    private readonly rapidApiHost = env.HIGHLIGHTLY_RAPIDAPI_HOST,
    private readonly league = env.HIGHLIGHTLY_BASKETBALL_LEAGUE
  ) {}

  async listFixtures(query: FixtureQuery): Promise<Fixture[]> {
    if (query.sport && query.sport !== "basketball") {
      return [];
    }

    const params = new URLSearchParams({
      league: this.league
    });

    if (query.externalFixtureId) params.set("matchId", query.externalFixtureId);
    if (query.from) params.set("date", query.from);

    const matches = await this.request("/matches", params);
    return matches.map((match) => this.toFixture(match));
  }

  async listLiveFixtures(): Promise<Fixture[]> {
    const params = new URLSearchParams({
      league: this.league
    });

    try {
      const matches = await this.request("/matches/live", params);
      return matches.map((match) => this.toFixture(match));
    } catch {
      const today = new Date().toISOString().slice(0, 10);
      const matches = await this.request(
        "/matches",
        new URLSearchParams({
          league: this.league,
          date: today
        })
      );

      return matches.map((match) => this.toFixture(match)).filter((fixture) => fixture.status === "live");
    }
  }

  async getFixtureResult(externalFixtureId: string): Promise<ProviderFixtureResult> {
    const matches = await this.request("/matches", new URLSearchParams({ matchId: externalFixtureId }));
    const match = matches[0];
    if (!match) {
      throw new Error(`Highlightly match not found: ${externalFixtureId}`);
    }

    const fixtureId = this.fixtureId(match.id);
    const result: ProviderFixtureResult = {
      source: {
        provider: this.provider,
        externalFixtureId: String(match.id),
        sourceUrl: `${this.baseUrl}/matches?matchId=${match.id}`,
        fetchedAt: new Date().toISOString()
      },
      fixtureId,
      status: mapMatchStatus(match.state.description),
      observedAt: new Date().toISOString()
    };

    const homeScore = totalScore(match.homeScore);
    const awayScore = totalScore(match.awayScore);
    if (homeScore !== undefined && awayScore !== undefined) {
      result.score = {
        homeGoals: homeScore,
        awayGoals: awayScore
      };
    }

    return result;
  }

  private async request(path: string, params: URLSearchParams): Promise<HighlightlyMatch[]> {
    if (!this.apiKey) {
      throw new Error("HIGHLIGHTLY_API_KEY is required to use Highlightly");
    }

    const url = new URL(path, this.baseUrl);
    url.search = params.toString();

    const headers: Record<string, string> = {
      "x-rapidapi-key": this.apiKey
    };
    if (this.rapidApiHost) {
      headers["x-rapidapi-host"] = this.rapidApiHost;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Highlightly request failed with ${response.status}: ${response.statusText}`);
    }

    const body = (await response.json()) as HighlightlyResponse<HighlightlyMatch> | HighlightlyMatch[];
    if (Array.isArray(body)) return body;
    return body.data ?? [];
  }

  private toFixture(match: HighlightlyMatch): Fixture {
    return {
      id: this.fixtureId(match.id),
      sport: "basketball",
      source: {
        provider: this.provider,
        externalFixtureId: String(match.id),
        sourceUrl: `${this.baseUrl}/matches?matchId=${match.id}`,
        fetchedAt: new Date().toISOString()
      },
      competition: {
        kind: "competition",
        id: match.league,
        name: match.league
      },
      homeCompetitor: match.homeTeam.name,
      awayCompetitor: match.awayTeam.name,
      ...(teamLogoUrl(match.homeTeam) ? { homeLogoUrl: teamLogoUrl(match.homeTeam) } : {}),
      ...(teamLogoUrl(match.awayTeam) ? { awayLogoUrl: teamLogoUrl(match.awayTeam) } : {}),
      kickoffTime: new Date(match.date).toISOString(),
      status: mapMatchStatus(match.state.description)
    };
  }

  private fixtureId(externalFixtureId: number): string {
    return `highlightly:${externalFixtureId}`;
  }
}

export function createHighlightlySource(): HighlightlySource | undefined {
  if (!env.HIGHLIGHTLY_API_KEY) {
    return undefined;
  }

  return new HighlightlySource(env.HIGHLIGHTLY_API_KEY);
}

function mapMatchStatus(status: string): FixtureStatus {
  const normalized = status.toLowerCase();

  if (normalized.includes("not started") || normalized.includes("scheduled")) return "scheduled";
  if (normalized.includes("in progress") || normalized.includes("live")) return "live";
  if (normalized.includes("finished") || normalized.includes("ended") || normalized.includes("final")) return "finished";
  if (normalized.includes("postponed")) return "postponed";
  if (normalized.includes("cancelled") || normalized.includes("canceled")) return "cancelled";
  if (normalized.includes("abandoned")) return "abandoned";

  return "scheduled";
}

function totalScore(score: HighlightlyScore | null | undefined): number | undefined {
  if (!score) return undefined;
  if (typeof score.total === "number") return score.total;

  const periodScores = Object.entries(score)
    .filter(([period, value]) => period !== "total" && typeof value === "number")
    .map(([, value]) => value as number);

  if (periodScores.length === 0) return undefined;
  return periodScores.reduce((sum, value) => sum + value, 0);
}

function teamLogoUrl(team: HighlightlyTeam): string | undefined {
  return team.logo ?? team.logoUrl ?? team.image ?? team.imageUrl ?? undefined;
}
