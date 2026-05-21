import { env } from "../config/env.js";
import type { Fixture, FixtureStatus, PlayerIdentity, ProviderFixtureResult } from "../markets/types.js";
import type {
  FixtureInsights,
  FixtureMeeting,
  FixtureQuery,
  MarketDataSource,
  PlayerCandidate,
  PlayerCandidateQuery,
  TeamFormGauge,
  TeamStanding
} from "./types.js";

type ApiFootballFixture = {
  fixture: {
    id: number;
    date: string;
    timestamp: number;
    status: {
      short: string | null;
    };
  };
  league: {
    id: number;
    name?: string | null;
    season: number;
  };
  teams: {
    home: { id: number; name: string; logo?: string | null };
    away: { id: number; name: string; logo?: string | null };
  };
  goals: {
    home: number | null;
    away: number | null;
  };
  score?: {
    halftime?: {
      home: number | null;
      away: number | null;
    };
  };
};

type ApiFootballStanding = {
  rank: number;
  team: {
    id: number;
    name: string;
  };
  points: number | null;
  goalsDiff: number | null;
  group: string | null;
  form: string | null;
  all: {
    played: number | null;
    win: number | null;
    draw: number | null;
    lose: number | null;
  };
};

type ApiFootballStandingsResponse = {
  league: {
    id: number;
    name: string;
    season: number;
    standings: ApiFootballStanding[][];
  };
};

type ApiFootballPlayerStats = {
  player: {
    id: number;
    name: string;
  };
  statistics: {
    team: {
      id: number;
      name: string;
    };
    games: {
      appearances: number | null;
      minutes: number | null;
      position: string | null;
    };
    shots: {
      on: number | null;
    };
    goals: {
      total: number | null;
      assists: number | null;
    };
  }[];
};

type ApiFootballResponse<T> = {
  response: T[];
  paging?: {
    current: number;
    total: number;
  };
  errors?: unknown;
};

type ApiFootballEvent = {
  time: {
    elapsed: number | null;
    extra: number | null;
  };
  team: {
    id: number;
    name: string;
  };
  player?: {
    id: number | null;
    name: string | null;
  } | null;
  type: string;
  detail: string;
};

export class ApiFootballSource implements MarketDataSource {
  readonly provider = "api-football";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = env.API_FOOTBALL_BASE_URL
  ) {}

  async listFixtures(query: FixtureQuery): Promise<Fixture[]> {
    if (query.sport && query.sport !== "football") {
      return [];
    }

    const params = new URLSearchParams();
    if (query.externalFixtureId) params.set("id", query.externalFixtureId);
    if (query.leagueId) params.set("league", query.leagueId);
    if (query.season) params.set("season", query.season);
    if (!query.externalFixtureId && query.from && (!query.to || query.to === query.from)) {
      params.set("date", query.from);
    } else {
      if (query.from) params.set("from", query.from);
      if (query.to) params.set("to", query.to);
    }

    const fixtures = await this.request<ApiFootballFixture>("/fixtures", params);
    const allowedLeagueIds = query.allowedLeagueIds ? new Set(query.allowedLeagueIds) : undefined;
    return fixtures
      .filter((fixture) => !allowedLeagueIds || allowedLeagueIds.has(String(fixture.league.id)))
      .map((fixture) => this.toFixture(fixture));
  }

  async listLiveFixtures(): Promise<Fixture[]> {
    const fixtures = await this.request<ApiFootballFixture>("/fixtures", new URLSearchParams({ live: "all" }));
    return fixtures.map((fixture) => this.toFixture(fixture));
  }

  async listPlayerCandidates(query: PlayerCandidateQuery): Promise<PlayerCandidate[]> {
    const [fixture] = await this.request<ApiFootballFixture>(
      "/fixtures",
      new URLSearchParams({ id: query.externalFixtureId })
    );
    if (!fixture) {
      throw new Error(`API-Football fixture not found: ${query.externalFixtureId}`);
    }

    const limitPerTeam = query.limitPerTeam ?? 3;
    const [homeCandidates, awayCandidates] = await Promise.all([
      this.teamPlayerCandidates(fixture, fixture.teams.home.id, "home", limitPerTeam),
      this.teamPlayerCandidates(fixture, fixture.teams.away.id, "away", limitPerTeam)
    ]);

    return [...homeCandidates, ...awayCandidates].sort((a, b) => b.score - a.score);
  }

  async getFixtureInsights(query: { externalFixtureId: string }): Promise<FixtureInsights> {
    const [fixture] = await this.request<ApiFootballFixture>(
      "/fixtures",
      new URLSearchParams({ id: query.externalFixtureId })
    );
    if (!fixture) {
      throw new Error(`API-Football fixture not found: ${query.externalFixtureId}`);
    }

    const [headToHeadFixtures, standings] = await Promise.all([
      this.request<ApiFootballFixture>(
        "/fixtures/headtohead",
        new URLSearchParams({
          h2h: `${fixture.teams.home.id}-${fixture.teams.away.id}`,
          last: "5"
        })
      ),
      this.leagueStandings(fixture)
    ]);

    const homeStanding = standings.find((standing) => standing.team.id === fixture.teams.home.id);
    const awayStanding = standings.find((standing) => standing.team.id === fixture.teams.away.id);

    return {
      fixtureId: this.fixtureId(fixture.fixture.id),
      source: {
        provider: this.provider,
        externalFixtureId: String(fixture.fixture.id),
        sourceUrl: `${this.baseUrl}/fixtures?id=${fixture.fixture.id}`,
        fetchedAt: new Date().toISOString()
      },
      league: {
        id: String(fixture.league.id),
        ...(fixture.league.name ? { name: fixture.league.name } : {}),
        season: fixture.league.season
      },
      headToHead: summarizeHeadToHead(fixture, headToHeadFixtures),
      formGauge: {
        home: toFormGauge(fixture.teams.home.id, fixture.teams.home.name, homeStanding?.form),
        away: toFormGauge(fixture.teams.away.id, fixture.teams.away.name, awayStanding?.form)
      },
      lastMeetings: headToHeadFixtures
        .filter((meeting) => mapFixtureStatus(meeting.fixture.status.short) === "finished")
        .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
        .slice(0, 5)
        .map(toFixtureMeeting),
      standings: {
        ...(homeStanding ? { home: toTeamStanding(homeStanding) } : {}),
        ...(awayStanding ? { away: toTeamStanding(awayStanding) } : {})
      }
    };
  }

  async getFixtureResult(externalFixtureId: string): Promise<ProviderFixtureResult> {
    const params = new URLSearchParams({ id: externalFixtureId });
    const [fixture] = await this.request<ApiFootballFixture>("/fixtures", params);
    if (!fixture) {
      throw new Error(`API-Football fixture not found: ${externalFixtureId}`);
    }

    const fixtureId = this.fixtureId(fixture.fixture.id);
    const result: ProviderFixtureResult = {
      source: {
        provider: this.provider,
        externalFixtureId: String(fixture.fixture.id),
        sourceUrl: `${this.baseUrl}/fixtures?id=${fixture.fixture.id}`,
        fetchedAt: new Date().toISOString()
      },
      fixtureId,
      status: mapFixtureStatus(fixture.fixture.status.short),
      observedAt: new Date().toISOString()
    };

    if (fixture.goals.home !== null && fixture.goals.away !== null) {
      result.score = {
        homeGoals: fixture.goals.home,
        awayGoals: fixture.goals.away
      };

      const scoringEvents = await this.scoringEvents(fixture.fixture.id);
      result.scoringPlayers = scoringEvents
        .map((event) => this.scoringPlayer(fixture, event))
        .filter(isPlayerIdentity);
      result.scoringPlayerNames = scoringEvents
        .map((event) => event.player?.name)
        .filter(isNonEmptyString);

      if (fixture.goals.home + fixture.goals.away === 0) {
        result.homeTeamScoredFirst = false;
      } else {
        result.homeTeamScoredFirst = this.homeTeamScoredFirst(fixture, scoringEvents);
      }
    }

    if (fixture.score?.halftime?.home !== null && fixture.score?.halftime?.away !== null) {
      const homeGoals = fixture.score?.halftime?.home;
      const awayGoals = fixture.score?.halftime?.away;
      if (homeGoals !== undefined && awayGoals !== undefined) {
        result.halfTimeScore = {
          homeGoals,
          awayGoals
        };
      }
    }

    return result;
  }

  private async scoringEvents(fixtureId: number): Promise<ApiFootballEvent[]> {
    const events = await this.request<ApiFootballEvent>(
      "/fixtures/events",
      new URLSearchParams({ fixture: String(fixtureId) })
    );
    return events.filter(isScoringEvent).sort((a, b) => eventMinute(a) - eventMinute(b));
  }

  private async teamPlayerCandidates(
    fixture: ApiFootballFixture,
    teamId: number,
    teamSide: PlayerIdentity["teamSide"],
    limit: number
  ): Promise<PlayerCandidate[]> {
    const players = await this.allPlayerStats(
      new URLSearchParams({
        team: String(teamId),
        league: String(fixture.league.id),
        season: String(env.API_FOOTBALL_PLAYER_STATS_SEASON || fixture.league.season)
      })
    );
    const rankedSource =
      players.length > 0
        ? players
        : await this.topScorersForTeam(fixture, teamId);

    return rankedSource
      .map((entry) => this.toPlayerCandidate(entry, teamSide))
      .filter(isPlayerCandidate)
      .filter((candidate) => isScorerCandidate(candidate))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private async topScorersForTeam(
    fixture: ApiFootballFixture,
    teamId: number
  ): Promise<ApiFootballPlayerStats[]> {
    const scorers = await this.request<ApiFootballPlayerStats>(
      "/players/topscorers",
      new URLSearchParams({
        league: String(fixture.league.id),
        season: String(env.API_FOOTBALL_PLAYER_STATS_SEASON || fixture.league.season)
      })
    );

    return scorers.filter((entry) => entry.statistics[0]?.team.id === teamId);
  }

  private async leagueStandings(fixture: ApiFootballFixture): Promise<ApiFootballStanding[]> {
    const [standingsResponse] = await this.request<ApiFootballStandingsResponse>(
      "/standings",
      new URLSearchParams({
        league: String(fixture.league.id),
        season: String(fixture.league.season)
      })
    );

    return standingsResponse?.league.standings.flat() ?? [];
  }

  private async allPlayerStats(params: URLSearchParams): Promise<ApiFootballPlayerStats[]> {
    const firstPage = await this.requestWithPaging<ApiFootballPlayerStats>("/players", params);
    const players = [...firstPage.response];

    for (let page = firstPage.current + 1; page <= firstPage.total; page += 1) {
      const pageParams = new URLSearchParams(params);
      pageParams.set("page", String(page));
      const nextPage = await this.requestWithPaging<ApiFootballPlayerStats>("/players", pageParams);
      players.push(...nextPage.response);
    }

    return players;
  }

  private toPlayerCandidate(
    entry: ApiFootballPlayerStats,
    teamSide: PlayerIdentity["teamSide"]
  ): PlayerCandidate | undefined {
    const stats = entry.statistics[0];
    if (!stats) return undefined;

    const goals = stats.goals.total ?? 0;
    const assists = stats.goals.assists ?? 0;
    const shotsOnTarget = stats.shots.on ?? 0;
    const appearances = stats.games.appearances ?? 0;
    const minutes = stats.games.minutes ?? 0;
    const position = stats.games.position ?? undefined;
    const score = goals * 10 + assists * 3 + shotsOnTarget * 2 + appearances * 0.5 + minutes / 300;
    const reasons = [
      `${goals} goals`,
      `${assists} assists`,
      `${shotsOnTarget} shots on target`,
      `${minutes} minutes`,
      ...(position ? [position] : [])
    ];

    return {
      player: {
        provider: this.provider,
        playerId: String(entry.player.id),
        playerName: entry.player.name,
        teamSide
      },
      score,
      reasons,
      stats: {
        goals,
        assists,
        shotsOnTarget,
        appearances,
        minutes,
        position
      }
    };
  }

  private homeTeamScoredFirst(
    fixture: ApiFootballFixture,
    scoringEvents: ApiFootballEvent[]
  ): boolean | undefined {
    const firstGoal = scoringEvents
      .filter(isScoringEvent)
      .sort((a, b) => eventMinute(a) - eventMinute(b))[0];

    if (!firstGoal) {
      return undefined;
    }

    return firstGoal.team.id === fixture.teams.home.id;
  }

  private scoringPlayer(fixture: ApiFootballFixture, event: ApiFootballEvent): PlayerIdentity | undefined {
    const playerName = event.player?.name;
    if (!playerName) return undefined;

    return {
      provider: this.provider,
      playerName,
      ...(event.player?.id ? { playerId: String(event.player.id) } : {}),
      teamSide: event.team.id === fixture.teams.home.id ? "home" : "away"
    };
  }

  private async request<T>(path: string, params: URLSearchParams): Promise<T[]> {
    return (await this.requestWithPaging<T>(path, params)).response;
  }

  private async requestWithPaging<T>(
    path: string,
    params: URLSearchParams
  ): Promise<{ response: T[]; current: number; total: number }> {
    if (!this.apiKey) {
      throw new Error("API_FOOTBALL_KEY is required to use API-Football");
    }

    const url = new URL(path, this.baseUrl);
    url.search = params.toString();

    const response = await fetch(url, {
      headers: {
        "x-apisports-key": this.apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`API-Football request failed with ${response.status}: ${response.statusText}`);
    }

    const body = (await response.json()) as ApiFootballResponse<T>;
    if (body.errors && hasApiErrors(body.errors)) {
      throw new Error(`API-Football returned errors: ${JSON.stringify(body.errors)}`);
    }

    return {
      response: body.response,
      current: body.paging?.current ?? 1,
      total: body.paging?.total ?? 1
    };
  }

  private toFixture(input: ApiFootballFixture): Fixture {
    return {
      id: this.fixtureId(input.fixture.id),
      sport: "football",
      source: {
        provider: this.provider,
        externalFixtureId: String(input.fixture.id),
        sourceUrl: `${this.baseUrl}/fixtures?id=${input.fixture.id}`,
        fetchedAt: new Date().toISOString()
      },
      homeCompetitor: input.teams.home.name,
      awayCompetitor: input.teams.away.name,
      ...(input.teams.home.logo ? { homeLogoUrl: input.teams.home.logo } : {}),
      ...(input.teams.away.logo ? { awayLogoUrl: input.teams.away.logo } : {}),
      kickoffTime: new Date(input.fixture.timestamp * 1000).toISOString(),
      status: mapFixtureStatus(input.fixture.status.short)
    };
  }

  private fixtureId(externalFixtureId: number): string {
    return `api-football:${externalFixtureId}`;
  }
}

export function createApiFootballSource(): ApiFootballSource | undefined {
  if (!env.API_FOOTBALL_KEY) {
    return undefined;
  }

  return new ApiFootballSource(env.API_FOOTBALL_KEY);
}

function mapFixtureStatus(status: string | null): FixtureStatus {
  switch (status) {
    case "TBD":
    case "NS":
      return "scheduled";
    case "1H":
    case "HT":
    case "2H":
    case "ET":
    case "BT":
    case "P":
    case "SUSP":
    case "INT":
    case "LIVE":
      return "live";
    case "FT":
    case "AET":
    case "PEN":
      return "finished";
    case "PST":
      return "postponed";
    case "CANC":
      return "cancelled";
    case "ABD":
      return "abandoned";
    default:
      return "scheduled";
  }
}

function hasApiErrors(errors: unknown): boolean {
  if (Array.isArray(errors)) return errors.length > 0;
  if (errors && typeof errors === "object") return Object.keys(errors).length > 0;
  return Boolean(errors);
}

function isScoringEvent(event: ApiFootballEvent): boolean {
  if (event.type !== "Goal") return false;
  return !event.detail.toLowerCase().includes("missed");
}

function eventMinute(event: ApiFootballEvent): number {
  return (event.time.elapsed ?? 0) * 100 + (event.time.extra ?? 0);
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return Boolean(value);
}

function isPlayerIdentity(value: PlayerIdentity | undefined): value is PlayerIdentity {
  return Boolean(value);
}

function isPlayerCandidate(value: PlayerCandidate | undefined): value is PlayerCandidate {
  return Boolean(value);
}

function isScorerCandidate(candidate: PlayerCandidate): boolean {
  const position = candidate.stats.position?.toLowerCase() ?? "";
  if (position === "goalkeeper") return false;
  if (candidate.stats.minutes < 90) return false;
  if (position === "defender" && candidate.stats.goals < 2) return false;
  return candidate.score > 0;
}

function summarizeHeadToHead(
  fixture: ApiFootballFixture,
  meetings: ApiFootballFixture[]
): FixtureInsights["headToHead"] {
  const summary = {
    played: 0,
    homeWins: 0,
    draws: 0,
    awayWins: 0,
    homeGoals: 0,
    awayGoals: 0
  };

  for (const meeting of meetings) {
    if (mapFixtureStatus(meeting.fixture.status.short) !== "finished") continue;
    if (meeting.goals.home === null || meeting.goals.away === null) continue;

    const perspective = teamPerspective(fixture, meeting);
    if (!perspective) continue;

    const homePerspectiveGoals = perspective.homeIsMeetingHome ? meeting.goals.home : meeting.goals.away;
    const awayPerspectiveGoals = perspective.homeIsMeetingHome ? meeting.goals.away : meeting.goals.home;

    summary.played += 1;
    summary.homeGoals += homePerspectiveGoals;
    summary.awayGoals += awayPerspectiveGoals;

    if (homePerspectiveGoals > awayPerspectiveGoals) summary.homeWins += 1;
    else if (homePerspectiveGoals < awayPerspectiveGoals) summary.awayWins += 1;
    else summary.draws += 1;
  }

  return summary;
}

function teamPerspective(
  fixture: ApiFootballFixture,
  meeting: ApiFootballFixture
): { homeIsMeetingHome: boolean } | undefined {
  if (meeting.teams.home.id === fixture.teams.home.id && meeting.teams.away.id === fixture.teams.away.id) {
    return { homeIsMeetingHome: true };
  }

  if (meeting.teams.home.id === fixture.teams.away.id && meeting.teams.away.id === fixture.teams.home.id) {
    return { homeIsMeetingHome: false };
  }

  return undefined;
}

function toFormGauge(teamId: number, teamName: string, form: string | null | undefined): TeamFormGauge {
  const cleanForm = form?.toUpperCase().replace(/[^WDL]/g, "") ?? "";
  const points = [...cleanForm].reduce((sum, result) => {
    if (result === "W") return sum + 3;
    if (result === "D") return sum + 1;
    return sum;
  }, 0);
  const maxPoints = cleanForm.length * 3;
  const score = maxPoints > 0 ? Math.round((points / maxPoints) * 100) : 0;

  return {
    teamId: String(teamId),
    teamName,
    ...(cleanForm ? { form: cleanForm } : {}),
    score,
    summary: cleanForm ? `${points}/${maxPoints} points from recent league form` : "No recent form available"
  };
}

function toFixtureMeeting(meeting: ApiFootballFixture): FixtureMeeting {
  return {
    externalFixtureId: String(meeting.fixture.id),
    date: new Date(meeting.fixture.timestamp * 1000).toISOString(),
    ...(meeting.league.name ? { leagueName: meeting.league.name } : {}),
    homeTeam: meeting.teams.home.name,
    awayTeam: meeting.teams.away.name,
    ...(meeting.goals.home !== null ? { homeGoals: meeting.goals.home } : {}),
    ...(meeting.goals.away !== null ? { awayGoals: meeting.goals.away } : {}),
    status: mapFixtureStatus(meeting.fixture.status.short)
  };
}

function toTeamStanding(standing: ApiFootballStanding): TeamStanding {
  return {
    teamId: String(standing.team.id),
    teamName: standing.team.name,
    rank: standing.rank,
    points: standing.points ?? 0,
    goalsDiff: standing.goalsDiff ?? 0,
    ...(standing.form ? { form: standing.form } : {}),
    ...(standing.group ? { group: standing.group } : {}),
    played: standing.all.played ?? 0,
    wins: standing.all.win ?? 0,
    draws: standing.all.draw ?? 0,
    losses: standing.all.lose ?? 0
  };
}
