export type MarketType = "YES_NO" | "TOTAL_GOALS" | "BOTH_TEAMS_TO_SCORE";

export type Sport = "football" | "basketball" | "american_football" | "esports";

export type MarketStatus = "draft" | "open" | "closed" | "resolved" | "cancelled";

export type FixtureStatus = "scheduled" | "live" | "finished" | "postponed" | "cancelled" | "abandoned";

export type TotalGoalsLine = "0.5" | "1.5" | "2.5" | "3.5";

export type PlayerMarketTemplate = "HAT_TRICK" | "YELLOW_CARD";
export type MainCardPlayerMarketTemplate = "ANYTIME_GOALSCORER";

export type OutcomeSide = "NO" | "YES" | "UNDER" | "OVER";

export type BinaryIndexSet = 1 | 2;

export type Fixture = {
  id: string;
  sport: Sport;
  source: DataSourceRef;
  homeCompetitor: string;
  awayCompetitor: string;
  homeLogoUrl?: string | undefined;
  awayLogoUrl?: string | undefined;
  kickoffTime: string;
  status: FixtureStatus;
};

export type FootballFixture = Fixture & {
  sport: "football";
};

export type BasketballFixture = Fixture & {
  sport: "basketball";
};

export type AmericanFootballFixture = Fixture & {
  sport: "american_football";
};

export type EsportsFixture = Fixture & {
  sport: "esports";
  gameTitle?: string | undefined;
  tournamentName?: string | undefined;
};

export type Score = {
  homeGoals: number;
  awayGoals: number;
};

export type TeamSide = "home" | "away";

export type PlayerIdentity = {
  provider: string;
  playerId?: string | undefined;
  playerName: string;
  teamSide?: TeamSide | undefined;
};

export type OutcomeDefinition = {
  side: OutcomeSide;
  indexSet: BinaryIndexSet;
  label: string;
};

export type BaseMarketDefinition = {
  id: string;
  fixtureId?: string | undefined;
  type: MarketType;
  title: string;
  status: MarketStatus;
  source?: DataSourceRef | undefined;
  resolver?: ResolverConfig | undefined;
  outcomes: readonly [OutcomeDefinition, OutcomeDefinition];
  conditionId?: string | undefined;
  template?: MarketTemplateRef | undefined;
};

export type YesNoMarketDefinition = BaseMarketDefinition & {
  type: "YES_NO";
};

export type TotalGoalsMarketDefinition = BaseMarketDefinition & {
  type: "TOTAL_GOALS";
  sport: "football";
  fixtureId: string;
  line: TotalGoalsLine;
};

export type BothTeamsToScoreMarketDefinition = BaseMarketDefinition & {
  type: "BOTH_TEAMS_TO_SCORE";
  sport: "football";
  fixtureId: string;
};

export type MarketDefinition =
  | YesNoMarketDefinition
  | TotalGoalsMarketDefinition
  | BothTeamsToScoreMarketDefinition;

export type ResolutionOutcome = OutcomeSide | "VOID";

export type DataSourceRef = {
  provider: string;
  externalFixtureId?: string | undefined;
  externalMarketId?: string | undefined;
  sourceUrl?: string | undefined;
  fetchedAt?: string | undefined;
};

export type MarketTemplateRef =
  | {
      category: "PLAYER";
      template: PlayerMarketTemplate;
      player: PlayerIdentity;
    }
  | {
      category: "MAIN_PLAYER";
      template: MainCardPlayerMarketTemplate;
      player: PlayerIdentity;
    }
  | {
      category: "MAIN" | "FIRST_HALF" | "TOTALS" | "BOTH_TEAMS_TO_SCORE";
    };

export type ResolverRule =
  | "HOME_TEAM_WIN"
  | "DRAW"
  | "AWAY_TEAM_WIN"
  | "FIRST_HALF_HOME_TEAM_WIN"
  | "FIRST_HALF_DRAW"
  | "FIRST_HALF_AWAY_TEAM_WIN"
  | "HOME_TEAM_SCORE_FIRST"
  | "PLAYER_SCORED"
  | "TOTAL_GOALS"
  | "BOTH_TEAMS_TO_SCORE"
  | "EXPLICIT_YES_NO";

export type ResolverConfig = {
  rule: ResolverRule;
  source: DataSourceRef;
};

export type ProviderFixtureResult = {
  source: DataSourceRef;
  fixtureId: string;
  status: FixtureStatus;
  score?: Score | undefined;
  halfTimeScore?: Score | undefined;
  homeTeamScoredFirst?: boolean | undefined;
  scoringPlayers?: PlayerIdentity[] | undefined;
  scoringPlayerNames?: string[] | undefined;
  explicitOutcome?: "NO" | "YES" | undefined;
  observedAt: string;
};

export type ResolutionStatus = "computed" | "reviewed" | "submitted" | "rejected";

export type ResolutionDecision = {
  marketId: string;
  marketType: MarketType;
  outcome: ResolutionOutcome;
  payoutVector: readonly [number, number];
  status: ResolutionStatus;
  source: DataSourceRef;
  observedAt: string;
  computedAt: string;
  reason: string;
};
