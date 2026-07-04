import { env } from "../config/env.js";
import type { Fixture, FixtureStatus, ProviderFixtureResult } from "../markets/types.js";
import type { FixtureQuery, MarketDataSource } from "./types.js";

type FootballDataTeam = {
  id?: number | null;
  name: string;
  shortName?: string | null;
  tla?: string | null;
  crest?: string | null;
};

type FootballDataMatch = {
  id: number;
  utcDate: string;
  status: string;
  minute?: number | null;
  competition: {
    id: number;
    name: string;
    code?: string | null;
    type?: string | null;
    emblem?: string | null;
  };
  season?: {
    startDate?: string | null;
  } | null;
  homeTeam: FootballDataTeam;
  awayTeam: FootballDataTeam;
  score?: {
    winner?: "HOME_TEAM" | "AWAY_TEAM" | "DRAW" | null;
    fullTime?: {
      home?: number | null;
      away?: number | null;
    } | null;
    halfTime?: {
      home?: number | null;
      away?: number | null;
    } | null;
  } | null;
};

type FootballDataMatchListResponse = {
  matches: FootballDataMatch[];
};

export class FootballDataSource implements MarketDataSource {
  readonly provider = "football-data";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = env.FOOTBALL_DATA_BASE_URL
  ) {}

  async listFixtures(query: FixtureQuery): Promise<Fixture[]> {
    if (query.sport && query.sport !== "football") {
      return [];
    }

    const params = new URLSearchParams();
    if (query.externalFixtureId) {
      const match = await this.request<FootballDataMatch>(`/matches/${query.externalFixtureId}`);
      return [this.toFixture(match)];
    }

    if (query.from) params.set("dateFrom", query.from);
    if (query.to) params.set("dateTo", query.to);
    if (query.season) params.set("season", query.season);
    if (query.allowedLeagueIds?.length) params.set("competitions", query.allowedLeagueIds.join(","));

    const path = query.leagueId ? `/competitions/${query.leagueId}/matches` : "/matches";
    const body = await this.request<FootballDataMatchListResponse>(path, params);
    return body.matches.map((match) => this.toFixture(match));
  }

  async listLiveFixtures(): Promise<Fixture[]> {
    const body = await this.request<FootballDataMatchListResponse>(
      "/matches",
      new URLSearchParams({ status: "LIVE" })
    );
    return body.matches.map((match) => this.toFixture(match));
  }

  async getFixtureResult(externalFixtureId: string): Promise<ProviderFixtureResult> {
    const match = await this.request<FootballDataMatch>(`/matches/${externalFixtureId}`);
    const result: ProviderFixtureResult = {
      source: {
        provider: this.provider,
        externalFixtureId: String(match.id),
        sourceUrl: `${this.baseUrl}/matches/${match.id}`,
        fetchedAt: new Date().toISOString()
      },
      fixtureId: this.fixtureId(match.id),
      status: mapMatchStatus(match.status),
      observedAt: new Date().toISOString()
    };

    const fullTime = toScore(match.score?.fullTime);
    if (fullTime) {
      result.score = {
        homeGoals: fullTime.home,
        awayGoals: fullTime.away
      };
      result.homeTeamScoredFirst = fullTime.home + fullTime.away === 0 ? false : undefined;
    }

    const halfTime = toScore(match.score?.halfTime);
    if (halfTime) {
      result.halfTimeScore = {
        homeGoals: halfTime.home,
        awayGoals: halfTime.away
      };
    }

    return result;
  }

  private async request<T>(path: string, params?: URLSearchParams): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${path}`);
    if (params) url.search = params.toString();

    const response = await fetch(url, {
      headers: {
        "X-Auth-Token": this.apiKey
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`football-data request failed with ${response.status}: ${body || response.statusText}`);
    }

    return await response.json() as T;
  }

  private toFixture(match: FootballDataMatch): Fixture {
    return {
      id: this.fixtureId(match.id),
      sport: "football",
      source: {
        provider: this.provider,
        externalFixtureId: String(match.id),
        sourceUrl: `${this.baseUrl}/matches/${match.id}`,
        fetchedAt: new Date().toISOString()
      },
      competition: {
        kind: match.competition.type === "CUP" ? "tournament" : "league",
        id: match.competition.code ?? String(match.competition.id),
        name: match.competition.name,
        ...(seasonStartYear(match.season?.startDate) ? { season: seasonStartYear(match.season?.startDate) } : {})
      },
      homeCompetitor: match.homeTeam.name,
      awayCompetitor: match.awayTeam.name,
      ...(match.homeTeam.crest ? { homeLogoUrl: match.homeTeam.crest } : {}),
      ...(match.awayTeam.crest ? { awayLogoUrl: match.awayTeam.crest } : {}),
      kickoffTime: new Date(match.utcDate).toISOString(),
      status: mapMatchStatus(match.status)
    };
  }

  private fixtureId(externalFixtureId: number): string {
    return `football-data:${externalFixtureId}`;
  }
}

export function createFootballDataSource(): FootballDataSource | undefined {
  if (!env.FOOTBALL_DATA_TOKEN) {
    return undefined;
  }

  return new FootballDataSource(env.FOOTBALL_DATA_TOKEN);
}

function mapMatchStatus(status: string): FixtureStatus {
  switch (status) {
    case "SCHEDULED":
    case "TIMED":
      return "scheduled";
    case "IN_PLAY":
    case "PAUSED":
    case "EXTRA_TIME":
    case "PENALTY_SHOOTOUT":
    case "SUSPENDED":
    case "LIVE":
      return "live";
    case "FINISHED":
    case "AWARDED":
      return "finished";
    case "POSTPONED":
      return "postponed";
    case "CANCELLED":
      return "cancelled";
    default:
      return "scheduled";
  }
}

function toScore(input: { home?: number | null; away?: number | null } | null | undefined) {
  if (typeof input?.home !== "number" || typeof input.away !== "number") return undefined;
  return {
    home: input.home,
    away: input.away
  };
}

function seasonStartYear(startDate: string | null | undefined): string | undefined {
  return startDate?.slice(0, 4);
}
