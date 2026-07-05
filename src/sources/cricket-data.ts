import { env } from "../config/env.js";
import type { CricketFixture, Fixture, FixtureStatus, ProviderFixtureResult, Score } from "../markets/types.js";
import type { FixtureQuery, MarketDataSource } from "./types.js";

type CricketDataTeamInfo = {
  name?: string | null;
  shortname?: string | null;
  img?: string | null;
};

type CricketDataMatch = {
  id: string;
  name?: string | null;
  matchType?: string | null;
  status?: string | null;
  venue?: string | null;
  date?: string | null;
  dateTimeGMT?: string | null;
  teams?: string[] | null;
  teamInfo?: CricketDataTeamInfo[] | null;
  series_id?: string | null;
  series?: string | null;
  matchStarted?: boolean | null;
  matchEnded?: boolean | null;
};

type CricketDataListResponse = {
  data?: CricketDataMatch[] | null;
  status?: string | null;
  info?: {
    offset?: number | null;
    totalRows?: number | null;
  } | null;
};

type CricketDataMatchResponse = {
  data?: CricketDataMatch | null;
  status?: string | null;
};

export class CricketDataSource implements MarketDataSource {
  readonly provider = "cricket-data";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = env.CRICKET_DATA_BASE_URL
  ) {}

  async listFixtures(query: FixtureQuery): Promise<Fixture[]> {
    if (query.sport && query.sport !== "cricket") {
      return [];
    }

    if (query.externalFixtureId) {
      const match = await this.matchInfo(query.externalFixtureId);
      return match ? [this.toFixture(match)] : [];
    }

    const matches = await this.currentMatches();
    return matches
      .filter((match) => withinDateWindow(matchKickoffTime(match), query.from, query.to))
      .slice(0, env.CRICKET_DATA_SYNC_FIXTURE_LIMIT)
      .map((match) => this.toFixture(match))
      .filter((fixture) => fixture.homeCompetitor && fixture.awayCompetitor);
  }

  async listLiveFixtures(): Promise<Fixture[]> {
    const matches = await this.currentMatches();
    return matches
      .filter((match) => mapMatchStatus(match) === "live")
      .map((match) => this.toFixture(match));
  }

  async getFixtureResult(externalFixtureId: string): Promise<ProviderFixtureResult> {
    const match = await this.matchInfo(externalFixtureId);
    if (!match) {
      throw new Error(`CricketData match ${externalFixtureId} was not found`);
    }

    const result: ProviderFixtureResult = {
      source: {
        provider: this.provider,
        externalFixtureId: match.id,
        sourceUrl: `${this.baseUrl.replace(/\/$/, "")}/match_info?id=${encodeURIComponent(match.id)}`,
        fetchedAt: new Date().toISOString()
      },
      fixtureId: this.fixtureId(match.id),
      status: mapMatchStatus(match),
      observedAt: new Date().toISOString()
    };

    const winnerScore = winnerPseudoScore(match);
    if (winnerScore) {
      result.score = winnerScore;
    }

    return result;
  }

  private async currentMatches(): Promise<CricketDataMatch[]> {
    const matches: CricketDataMatch[] = [];
    const seen = new Set<string>();
    let offset = 0;

    for (let page = 0; page < 3; page += 1) {
      const params = new URLSearchParams({ offset: String(offset) });
      const body = await this.request<CricketDataListResponse>("/currentMatches", params);
      const pageMatches = body.data ?? [];
      for (const match of pageMatches) {
        if (!match.id || seen.has(match.id)) continue;
        seen.add(match.id);
        matches.push(match);
        if (matches.length >= env.CRICKET_DATA_SYNC_FIXTURE_LIMIT) break;
      }

      const totalRows = body.info?.totalRows;
      if (
        matches.length >= env.CRICKET_DATA_SYNC_FIXTURE_LIMIT ||
        typeof totalRows !== "number" ||
        matches.length >= totalRows ||
        pageMatches.length === 0
      ) {
        break;
      }
      offset = matches.length;
    }

    return matches;
  }

  private async matchInfo(externalFixtureId: string): Promise<CricketDataMatch | undefined> {
    const body = await this.request<CricketDataMatchResponse>(
      "/match_info",
      new URLSearchParams({ id: externalFixtureId })
    );
    return body.data ?? undefined;
  }

  private async request<T>(path: string, params?: URLSearchParams): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${path}`);
    url.searchParams.set("apikey", this.apiKey);
    if (params) {
      for (const [key, value] of params) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`cricket-data request failed with ${response.status}: ${body || response.statusText}`);
    }

    return await response.json() as T;
  }

  private toFixture(match: CricketDataMatch): CricketFixture {
    const teams = matchTeams(match);
    const teamInfo = match.teamInfo ?? [];

    return {
      id: this.fixtureId(match.id),
      sport: "cricket",
      source: {
        provider: this.provider,
        externalFixtureId: match.id,
        sourceUrl: `${this.baseUrl.replace(/\/$/, "")}/match_info?id=${encodeURIComponent(match.id)}`,
        fetchedAt: new Date().toISOString()
      },
      competition: {
        kind: "competition",
        id: match.series_id ?? match.matchType ?? "cricket",
        name: match.series ?? "Cricket"
      },
      homeCompetitor: teams.home,
      awayCompetitor: teams.away,
      ...(teamInfo[0]?.img ? { homeLogoUrl: teamInfo[0].img } : {}),
      ...(teamInfo[1]?.img ? { awayLogoUrl: teamInfo[1].img } : {}),
      kickoffTime: matchKickoffTime(match),
      status: mapMatchStatus(match),
      ...(match.matchType ? { matchType: match.matchType } : {}),
      ...(match.venue ? { venue: match.venue } : {})
    };
  }

  private fixtureId(externalFixtureId: string): string {
    return `${this.provider}:${externalFixtureId}`;
  }
}

export function createCricketDataSource(): CricketDataSource | undefined {
  if (!env.CRICKET_DATA_API_KEY) {
    return undefined;
  }

  return new CricketDataSource(env.CRICKET_DATA_API_KEY);
}

function matchTeams(match: CricketDataMatch): { home: string; away: string } {
  const teams = match.teams?.filter(Boolean) ?? [];
  if (teams.length >= 2) {
    return { home: teams[0]!, away: teams[1]! };
  }

  const [home, away] = (match.name ?? "").split(/\s+v(?:s\.?)?\s+/i).map((team) => team.trim());
  return {
    home: home || "Home Team",
    away: away || "Away Team"
  };
}

function matchKickoffTime(match: CricketDataMatch): string {
  const raw = match.dateTimeGMT ?? match.date;
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function withinDateWindow(kickoffTime: string, from: string | undefined, to: string | undefined): boolean {
  const time = Date.parse(kickoffTime);
  if (Number.isNaN(time)) return false;

  if (from && time < Date.parse(`${from}T00:00:00.000Z`)) {
    return false;
  }

  if (to && time > Date.parse(`${to}T23:59:59.999Z`)) {
    return false;
  }

  return true;
}

function mapMatchStatus(match: CricketDataMatch): FixtureStatus {
  const status = (match.status ?? "").toLowerCase();

  if (status.includes("abandon") || status.includes("cancel") || status.includes("no result")) {
    return "abandoned";
  }

  if (match.matchEnded || status.includes("won") || status.includes("draw") || status.includes("tied")) {
    return "finished";
  }

  if (match.matchStarted || status.includes("live") || status.includes("stumps")) {
    return "live";
  }

  return "scheduled";
}

function winnerPseudoScore(match: CricketDataMatch): Score | undefined {
  const status = normalize(match.status ?? "");
  if (!status.includes(" won ")) return undefined;

  const teams = matchTeams(match);
  const home = normalize(teams.home);
  const away = normalize(teams.away);
  const winnerText = status.split(" won ")[0]?.trim() ?? "";

  if (winnerText === home || home.includes(winnerText) || winnerText.includes(home)) {
    return { homeGoals: 1, awayGoals: 0 };
  }

  if (winnerText === away || away.includes(winnerText) || winnerText.includes(away)) {
    return { homeGoals: 0, awayGoals: 1 };
  }

  return undefined;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
