import type { Fixture, PlayerIdentity, ProviderFixtureResult, Sport } from "../markets/types.js";

export type FixtureQuery = {
  sport?: Sport;
  from?: string;
  to?: string;
  externalFixtureId?: string;
  leagueId?: string;
  season?: string;
  allowedLeagueIds?: readonly string[];
};

export type PlayerCandidateQuery = {
  externalFixtureId: string;
  limitPerTeam?: number | undefined;
  cache?: PlayerCandidateCache | undefined;
};

export type PlayerCandidate = {
  player: PlayerIdentity;
  score: number;
  reasons: string[];
  stats: {
    goals: number;
    assists: number;
    shotsOnTarget: number;
    appearances: number;
    minutes: number;
    position?: string | undefined;
  };
};

export type PlayerCandidateCache = {
  getPlayerCandidates(cacheKey: string): { candidates: PlayerCandidate[] } | undefined;
  upsertPlayerCandidates(cacheKey: string, candidates: PlayerCandidate[], ttlMs: number): unknown;
};

export type FixtureInsightsQuery = {
  externalFixtureId: string;
};

export type FixtureInsights = {
  fixtureId: string;
  source: {
    provider: string;
    externalFixtureId: string;
    sourceUrl?: string | undefined;
    fetchedAt: string;
  };
  league: {
    id: string;
    name?: string | undefined;
    season?: number | undefined;
  };
  headToHead: {
    played: number;
    homeWins: number;
    draws: number;
    awayWins: number;
    homeGoals: number;
    awayGoals: number;
  };
  formGauge: {
    home: TeamFormGauge;
    away: TeamFormGauge;
  };
  lastMeetings: FixtureMeeting[];
  standings: {
    home?: TeamStanding | undefined;
    away?: TeamStanding | undefined;
  };
};

export type TeamFormGauge = {
  teamId: string;
  teamName: string;
  form?: string | undefined;
  score: number;
  summary: string;
};

export type FixtureMeeting = {
  externalFixtureId: string;
  date: string;
  leagueName?: string | undefined;
  homeTeam: string;
  awayTeam: string;
  homeGoals?: number | undefined;
  awayGoals?: number | undefined;
  status: string;
};

export type TeamStanding = {
  teamId: string;
  teamName: string;
  rank: number;
  points: number;
  goalsDiff: number;
  form?: string | undefined;
  group?: string | undefined;
  played: number;
  wins: number;
  draws: number;
  losses: number;
};

export interface MarketDataSource {
  readonly provider: string;

  listFixtures(query: FixtureQuery): Promise<Fixture[]>;

  listLiveFixtures?(): Promise<Fixture[]>;

  listPlayerCandidates?(query: PlayerCandidateQuery): Promise<PlayerCandidate[]>;

  getFixtureInsights?(query: FixtureInsightsQuery): Promise<FixtureInsights>;

  getFixtureResult(externalFixtureId: string): Promise<ProviderFixtureResult>;
}
