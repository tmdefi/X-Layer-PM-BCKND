import { BOTH_TEAMS_TO_SCORE_OUTCOMES, TOTAL_GOALS_OUTCOMES, YES_NO_OUTCOMES } from "./outcomes.js";
import type {
  BothTeamsToScoreMarketDefinition,
  BasketballFixture,
  DataSourceRef,
  EsportsFixture,
  Fixture,
  FootballFixture,
  MarketStatus,
  MainCardPlayerMarketTemplate,
  MmaFixture,
  CompetitionRef,
  PlayerIdentity,
  PlayerMarketTemplate,
  PlayerTournamentFutureTemplate,
  ResolverConfig,
  TotalGoalsLine,
  TotalGoalsMarketDefinition,
  YesNoMarketDefinition
} from "./types.js";

export const DEFAULT_TOTAL_GOALS_LINES = ["0.5", "1.5", "2.5", "3.5"] as const;
export const PLAYER_TOURNAMENT_FUTURE_OVER_LINES = ["3.5", "4.5", "5.5"] as const;

export const PLAYER_MARKET_TEMPLATES = [
  {
    template: "HAT_TRICK",
    label: "To Score a Hat Trick",
    title: (playerName: string) => `${playerName} to score a hat trick`
  },
  {
    template: "YELLOW_CARD",
    label: "To Get a Yellow Card",
    title: (playerName: string) => `${playerName} to get a yellow card`
  }
] as const satisfies readonly {
  template: PlayerMarketTemplate;
  label: string;
  title: (playerName: string) => string;
}[];

export const MAIN_CARD_PLAYER_MARKET_TEMPLATES = [
  {
    template: "ANYTIME_GOALSCORER",
    label: "To Score During the Match",
    title: (playerName: string) => `${playerName} to score during the match`
  }
] as const satisfies readonly {
  template: MainCardPlayerMarketTemplate;
  label: string;
  title: (playerName: string) => string;
}[];

export const PLAYER_TOURNAMENT_FUTURE_TEMPLATES = [
  {
    template: "TOURNAMENT_GOALS_OVER",
    label: "Tournament Goals Over",
    requiresLine: true,
    title: (playerName: string, line?: string) => `${playerName} tournament goals over ${line}`
  },
  {
    template: "TOURNAMENT_ASSISTS_OVER",
    label: "Tournament Assists Over",
    requiresLine: true,
    title: (playerName: string, line?: string) => `${playerName} tournament assists over ${line}`
  },
  {
    template: "TOURNAMENT_CARDS_OVER",
    label: "Tournament Cards Over",
    requiresLine: true,
    title: (playerName: string, line?: string) => `${playerName} tournament cards over ${line}`
  },
  {
    template: "TOURNAMENT_FOULS_OVER",
    label: "Tournament Fouls Over",
    requiresLine: true,
    title: (playerName: string, line?: string) => `${playerName} tournament fouls committed over ${line}`
  },
  {
    template: "TOURNAMENT_FREE_KICK_GOAL",
    label: "To Score From a Free Kick",
    requiresLine: false,
    title: (playerName: string) => `${playerName} to score from a free kick`
  }
] as const satisfies readonly {
  template: PlayerTournamentFutureTemplate;
  label: string;
  requiresLine: boolean;
  title: (playerName: string, line?: string) => string;
}[];

type CreateFixtureMarketsOptions = {
  status?: MarketStatus | undefined;
  totalGoalsLines?: readonly TotalGoalsLine[] | undefined;
};

export function createYesNoMarket(input: {
  id: string;
  title: string;
  fixtureId?: string | undefined;
  source?: DataSourceRef | undefined;
  resolver?: ResolverConfig | undefined;
  status?: MarketStatus | undefined;
  template?: YesNoMarketDefinition["template"] | undefined;
}): YesNoMarketDefinition {
  return {
    id: input.id,
    type: "YES_NO",
    title: input.title,
    status: input.status ?? "draft",
    tradingStatus: input.status === "open" ? "open" : "closed",
    outcomes: YES_NO_OUTCOMES,
    ...(input.fixtureId ? { fixtureId: input.fixtureId } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.resolver ? { resolver: input.resolver } : {}),
    ...(input.template ? { template: input.template } : {})
  };
}

export function createTotalGoalsMarket(
  fixture: FootballFixture,
  line: TotalGoalsLine,
  status: MarketStatus = "draft"
): TotalGoalsMarketDefinition {
  return {
    id: `${fixture.id}:total-goals:${line}`,
    fixtureId: fixture.id,
    type: "TOTAL_GOALS",
    sport: "football",
    line,
    title: `${fixture.homeCompetitor} vs ${fixture.awayCompetitor} - Total Goals ${line}`,
    status,
    tradingStatus: status === "open" ? "open" : "closed",
    source: fixture.source,
    resolver: {
      rule: "TOTAL_GOALS",
      source: fixture.source
    },
    outcomes: [
      { ...TOTAL_GOALS_OUTCOMES[0], label: `Under ${line}` },
      { ...TOTAL_GOALS_OUTCOMES[1], label: `Over ${line}` }
    ]
  };
}

export function createBothTeamsToScoreMarket(
  fixture: FootballFixture,
  status: MarketStatus = "draft"
): BothTeamsToScoreMarketDefinition {
  return {
    id: `${fixture.id}:both-teams-to-score`,
    fixtureId: fixture.id,
    type: "BOTH_TEAMS_TO_SCORE",
    sport: "football",
    title: `${fixture.homeCompetitor} vs ${fixture.awayCompetitor} - Both Teams To Score`,
    status,
    tradingStatus: status === "open" ? "open" : "closed",
    source: fixture.source,
    resolver: {
      rule: "BOTH_TEAMS_TO_SCORE",
      source: fixture.source
    },
    outcomes: BOTH_TEAMS_TO_SCORE_OUTCOMES
  };
}

export function createHomeTeamWinMarket(
  fixture: FootballFixture | BasketballFixture | MmaFixture | EsportsFixture,
  status: MarketStatus = "draft"
): YesNoMarketDefinition {
  return createYesNoMarket({
    id: `${fixture.id}:home-team-win`,
    fixtureId: fixture.id,
    title: `${fixture.homeCompetitor} to beat ${fixture.awayCompetitor}`,
    status,
    source: fixture.source,
    resolver: {
      rule: "HOME_TEAM_WIN",
      source: fixture.source
    },
    template: { category: "MAIN" }
  });
}

export function createDrawMarket(
  fixture: FootballFixture,
  status: MarketStatus = "draft"
): YesNoMarketDefinition {
  return createYesNoMarket({
    id: `${fixture.id}:draw`,
    fixtureId: fixture.id,
    title: `${fixture.homeCompetitor} vs ${fixture.awayCompetitor} to end in a draw`,
    status,
    source: fixture.source,
    resolver: {
      rule: "DRAW",
      source: fixture.source
    },
    template: { category: "MAIN" }
  });
}

export function createAwayTeamWinMarket(
  fixture: FootballFixture | BasketballFixture | MmaFixture | EsportsFixture,
  status: MarketStatus = "draft"
): YesNoMarketDefinition {
  return createYesNoMarket({
    id: `${fixture.id}:away-team-win`,
    fixtureId: fixture.id,
    title: `${fixture.awayCompetitor} to beat ${fixture.homeCompetitor}`,
    status,
    source: fixture.source,
    resolver: {
      rule: "AWAY_TEAM_WIN",
      source: fixture.source
    },
    template: { category: "MAIN" }
  });
}

export function createFirstHalfHomeTeamWinMarket(
  fixture: FootballFixture,
  status: MarketStatus = "draft"
): YesNoMarketDefinition {
  return createYesNoMarket({
    id: `${fixture.id}:first-half-home-team-win`,
    fixtureId: fixture.id,
    title: `${fixture.homeCompetitor} to win the first half`,
    status,
    source: fixture.source,
    resolver: {
      rule: "FIRST_HALF_HOME_TEAM_WIN",
      source: fixture.source
    },
    template: { category: "FIRST_HALF" }
  });
}

export function createFirstHalfDrawMarket(
  fixture: FootballFixture,
  status: MarketStatus = "draft"
): YesNoMarketDefinition {
  return createYesNoMarket({
    id: `${fixture.id}:first-half-draw`,
    fixtureId: fixture.id,
    title: `${fixture.homeCompetitor} vs ${fixture.awayCompetitor} to be tied at half time`,
    status,
    source: fixture.source,
    resolver: {
      rule: "FIRST_HALF_DRAW",
      source: fixture.source
    },
    template: { category: "FIRST_HALF" }
  });
}

export function createFirstHalfAwayTeamWinMarket(
  fixture: FootballFixture,
  status: MarketStatus = "draft"
): YesNoMarketDefinition {
  return createYesNoMarket({
    id: `${fixture.id}:first-half-away-team-win`,
    fixtureId: fixture.id,
    title: `${fixture.awayCompetitor} to win the first half`,
    status,
    source: fixture.source,
    resolver: {
      rule: "FIRST_HALF_AWAY_TEAM_WIN",
      source: fixture.source
    },
    template: { category: "FIRST_HALF" }
  });
}

export function createHomeTeamScoreFirstMarket(
  fixture: FootballFixture,
  status: MarketStatus = "draft"
): YesNoMarketDefinition {
  return createYesNoMarket({
    id: `${fixture.id}:home-team-score-first`,
    fixtureId: fixture.id,
    title: `${fixture.homeCompetitor} to score first`,
    status,
    source: fixture.source,
    resolver: {
      rule: "HOME_TEAM_SCORE_FIRST",
      source: fixture.source
    },
    template: { category: "MAIN" }
  });
}

export function createBasketballFixtureMarkets(fixture: BasketballFixture, options: CreateFixtureMarketsOptions = {}) {
  const status = options.status ?? "draft";

  return [
    createYesNoMarket({
      id: `${fixture.id}:home-team-win`,
      fixtureId: fixture.id,
      title: `${fixture.homeCompetitor} to beat ${fixture.awayCompetitor}`,
      status,
      source: fixture.source,
      resolver: {
        rule: "HOME_TEAM_WIN",
        source: fixture.source
      },
      template: { category: "MAIN" }
    }),
    createAwayTeamWinMarket(fixture, status)
  ];
}

export function createMmaFixtureMarkets(fixture: MmaFixture, options: CreateFixtureMarketsOptions = {}) {
  const status = options.status ?? "draft";

  return [
    createHomeTeamWinMarket(fixture, status),
    createAwayTeamWinMarket(fixture, status)
  ];
}

export function createEsportsFixtureMarkets(fixture: EsportsFixture, options: CreateFixtureMarketsOptions = {}) {
  const status = options.status ?? "draft";

  return [
    createHomeTeamWinMarket(fixture, status),
    createAwayTeamWinMarket(fixture, status)
  ];
}

export function createPlayerMarket(input: {
  fixture: FootballFixture;
  playerId?: string | undefined;
  playerName: string;
  teamSide?: PlayerIdentity["teamSide"] | undefined;
  template: PlayerMarketTemplate;
  status?: MarketStatus | undefined;
}): YesNoMarketDefinition {
  const template = playerMarketTemplate(input.template);
  const playerSlug = slugify(input.playerName);
  const templateSlug = input.template.toLowerCase().replaceAll("_", "-");
  const player = playerIdentity(input.fixture, input.playerName, input.playerId, input.teamSide);

  return createYesNoMarket({
    id: `${input.fixture.id}:player:${playerSlug}:${templateSlug}`,
    fixtureId: input.fixture.id,
    title: template.title(input.playerName),
    status: input.status,
    source: {
      ...input.fixture.source,
      externalMarketId: `player:${playerSlug}:${templateSlug}`
    },
    resolver: {
      rule: "EXPLICIT_YES_NO",
      source: input.fixture.source
    },
    template: {
      category: "PLAYER",
      template: input.template,
      player
    }
  });
}

export function createMainCardPlayerMarket(input: {
  fixture: FootballFixture;
  playerId?: string | undefined;
  playerName: string;
  teamSide?: PlayerIdentity["teamSide"] | undefined;
  template: MainCardPlayerMarketTemplate;
  status?: MarketStatus | undefined;
}): YesNoMarketDefinition {
  const template = mainCardPlayerMarketTemplate(input.template);
  const playerSlug = slugify(input.playerName);
  const templateSlug = input.template.toLowerCase().replaceAll("_", "-");
  const player = playerIdentity(input.fixture, input.playerName, input.playerId, input.teamSide);

  return createYesNoMarket({
    id: `${input.fixture.id}:main-player:${playerSlug}:${templateSlug}`,
    fixtureId: input.fixture.id,
    title: template.title(input.playerName),
    status: input.status,
    source: {
      ...input.fixture.source,
      externalMarketId: `main-player:${playerSlug}:${templateSlug}`
    },
    resolver: {
      rule: "PLAYER_SCORED",
      source: input.fixture.source
    },
    template: {
      category: "MAIN_PLAYER",
      template: input.template,
      player
    }
  });
}

export function createPlayerTournamentFutureMarket(input: {
  provider: string;
  competition: CompetitionRef;
  playerId?: string | undefined;
  playerName: string;
  teamName?: string | undefined;
  imageUrl?: string | undefined;
  template: PlayerTournamentFutureTemplate;
  line?: string | undefined;
  status?: MarketStatus | undefined;
}): YesNoMarketDefinition {
  const template = playerTournamentFutureTemplate(input.template);
  if (template.requiresLine && !input.line) {
    throw new Error(`Tournament future template ${input.template} requires a line`);
  }
  if (template.requiresLine && input.line && !isPlayerTournamentFutureOverLine(input.line)) {
    throw new Error(`Tournament future template ${input.template} line must be one of ${PLAYER_TOURNAMENT_FUTURE_OVER_LINES.join(", ")}`);
  }
  const playerSlug = slugify(input.playerName);
  const templateSlug = input.template.toLowerCase().replaceAll("_", "-");
  const competitionSlug = slugify(`${input.competition.name}-${input.competition.season ?? input.competition.id ?? ""}`);
  const lineSlug = input.line ? `:${input.line}` : "";
  const source: DataSourceRef = {
    provider: input.provider,
    ...(input.competition.id ? { externalFixtureId: input.competition.id } : {}),
    externalMarketId: `player-future:${competitionSlug}:${playerSlug}:${templateSlug}${lineSlug}`,
    fetchedAt: new Date().toISOString()
  };
  const player: PlayerIdentity = {
    provider: input.provider,
    playerName: input.playerName,
    ...(input.playerId ? { playerId: input.playerId } : {}),
    ...(input.teamName ? { teamName: input.teamName } : {}),
    ...(input.imageUrl ? { imageUrl: input.imageUrl } : {})
  };

  return createYesNoMarket({
    id: `${input.provider}:${competitionSlug}:player-future:${playerSlug}:${templateSlug}${lineSlug}`,
    title: template.title(input.playerName, input.line),
    status: input.status,
    source,
    resolver: {
      rule: "PLAYER_TOURNAMENT_STAT",
      source
    },
    template: {
      category: "PLAYER_FUTURE",
      template: input.template,
      player,
      competition: input.competition,
      ...(input.line ? { line: input.line } : {})
    }
  });
}

export function createFootballFixtureMarkets(fixture: FootballFixture, options: CreateFixtureMarketsOptions = {}) {
  assertFootballFixture(fixture, "football fixture markets");

  const status = options.status ?? "draft";
  const lines = options.totalGoalsLines ?? DEFAULT_TOTAL_GOALS_LINES;

  return [
    createHomeTeamWinMarket(fixture, status),
    createDrawMarket(fixture, status),
    createAwayTeamWinMarket(fixture, status),
    createFirstHalfHomeTeamWinMarket(fixture, status),
    createFirstHalfDrawMarket(fixture, status),
    createFirstHalfAwayTeamWinMarket(fixture, status),
    createHomeTeamScoreFirstMarket(fixture, status),
    ...lines.map((line) => createTotalGoalsMarket(fixture, line, status)),
    createBothTeamsToScoreMarket(fixture, status)
  ];
}

function assertFootballFixture(fixture: Fixture, marketName: string): void {
  if (fixture.sport !== "football") {
    throw new Error(`${marketName} is only supported for football fixtures`);
  }
}

function playerMarketTemplate(template: PlayerMarketTemplate) {
  const found = PLAYER_MARKET_TEMPLATES.find((candidate) => candidate.template === template);
  if (!found) {
    throw new Error(`Unsupported player market template: ${template}`);
  }

  return found;
}

function mainCardPlayerMarketTemplate(template: MainCardPlayerMarketTemplate) {
  const found = MAIN_CARD_PLAYER_MARKET_TEMPLATES.find((candidate) => candidate.template === template);
  if (!found) {
    throw new Error(`Unsupported main-card player market template: ${template}`);
  }

  return found;
}

function playerTournamentFutureTemplate(template: PlayerTournamentFutureTemplate) {
  const found = PLAYER_TOURNAMENT_FUTURE_TEMPLATES.find((candidate) => candidate.template === template);
  if (!found) {
    throw new Error(`Unsupported player tournament future template: ${template}`);
  }

  return found;
}

function isPlayerTournamentFutureOverLine(line: string): boolean {
  return (PLAYER_TOURNAMENT_FUTURE_OVER_LINES as readonly string[]).includes(line);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function playerIdentity(
  fixture: FootballFixture,
  playerName: string,
  playerId: string | undefined,
  teamSide: PlayerIdentity["teamSide"] | undefined
): PlayerIdentity {
  return {
    provider: fixture.source.provider,
    playerName,
    ...(playerId ? { playerId } : {}),
    ...(teamSide ? { teamSide } : {})
  };
}
