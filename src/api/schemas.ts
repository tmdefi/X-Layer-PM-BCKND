import { z } from "zod";

export const sportSchema = z.enum(["football", "basketball", "american_football", "esports"]);

export const fixtureStatusSchema = z.enum([
  "scheduled",
  "live",
  "finished",
  "postponed",
  "cancelled",
  "abandoned"
]);

export const marketStatusSchema = z.enum(["draft", "open", "closed", "resolved", "cancelled"]);

export const playerMarketTemplateSchema = z.enum(["HAT_TRICK", "YELLOW_CARD"]);
export const mainCardPlayerMarketTemplateSchema = z.enum(["ANYTIME_GOALSCORER"]);
export const teamSideSchema = z.enum(["home", "away"]);

export const playerIdentityInputSchema = z.object({
  playerId: z.string().min(1).optional(),
  playerName: z.string().min(1),
  teamSide: teamSideSchema.optional()
});

export const dataSourceRefSchema = z.object({
  provider: z.string().min(1),
  externalFixtureId: z.string().min(1).optional(),
  externalMarketId: z.string().min(1).optional(),
  sourceUrl: z.string().url().optional(),
  fetchedAt: z.string().datetime().optional()
});

export const fixtureSchema = z.object({
  id: z.string().min(1),
  sport: sportSchema,
  source: dataSourceRefSchema,
  homeCompetitor: z.string().min(1),
  awayCompetitor: z.string().min(1),
  homeLogoUrl: z.string().url().optional(),
  awayLogoUrl: z.string().url().optional(),
  kickoffTime: z.string().datetime(),
  status: fixtureStatusSchema
});

export const createYesNoMarketSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  fixtureId: z.string().min(1).optional(),
  source: dataSourceRefSchema.optional(),
  status: marketStatusSchema.optional(),
  resolver: z
    .object({
      rule: z.enum([
        "HOME_TEAM_WIN",
        "DRAW",
        "AWAY_TEAM_WIN",
        "FIRST_HALF_HOME_TEAM_WIN",
        "FIRST_HALF_DRAW",
        "FIRST_HALF_AWAY_TEAM_WIN",
        "HOME_TEAM_SCORE_FIRST",
        "PLAYER_SCORED",
        "EXPLICIT_YES_NO"
      ]),
      source: dataSourceRefSchema
    })
    .optional()
});

export const generateFixtureMarketsSchema = z.object({
  status: marketStatusSchema.optional(),
  totalGoalsLines: z.array(z.enum(["0.5", "1.5", "2.5", "3.5"])).optional()
});

export const createPlayerMarketsSchema = z.object({
  status: marketStatusSchema.optional(),
  markets: z
    .array(
      z.object({
        playerId: z.string().min(1).optional(),
        playerName: z.string().min(1),
        teamSide: teamSideSchema.optional(),
        template: playerMarketTemplateSchema
      })
    )
    .min(1)
});

export const createMainCardPlayerMarketsSchema = z.object({
  status: marketStatusSchema.optional(),
  markets: z
    .array(
      z.object({
        playerId: z.string().min(1).optional(),
        playerName: z.string().min(1),
        teamSide: teamSideSchema.optional(),
        template: mainCardPlayerMarketTemplateSchema.default("ANYTIME_GOALSCORER")
      })
    )
    .min(1)
});

export const autoMainCardPlayerMarketsSchema = z.object({
  status: marketStatusSchema.optional(),
  limitPerTeam: z.coerce.number().int().min(1).max(5).default(3)
});

export const sourceFixtureQuerySchema = z.object({
  sport: sportSchema.optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  externalFixtureId: z.string().min(1).optional(),
  leagueId: z.string().min(1).optional(),
  season: z.string().min(1).optional(),
  persist: z.coerce.boolean().default(false)
});

export const currentFixtureQuerySchema = z.object({
  sport: sportSchema.optional(),
  days: z.coerce.number().int().min(1).max(14).default(3),
  persist: z.coerce.boolean().default(false),
  createMarkets: z.coerce.boolean().default(false),
  includeInsights: z.coerce.boolean().default(false)
});

export const scoreSchema = z.object({
  homeGoals: z.number().int().min(0),
  awayGoals: z.number().int().min(0)
});

export const providerFixtureResultSchema = z.object({
  source: dataSourceRefSchema,
  fixtureId: z.string().min(1),
  status: fixtureStatusSchema,
  score: scoreSchema.optional(),
  halfTimeScore: scoreSchema.optional(),
  homeTeamScoredFirst: z.boolean().optional(),
  scoringPlayers: z.array(playerIdentityInputSchema.extend({ provider: z.string().min(1) })).optional(),
  scoringPlayerNames: z.array(z.string().min(1)).optional(),
  explicitOutcome: z.enum(["NO", "YES"]).optional(),
  observedAt: z.string().datetime()
});

export const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Expected bytes32 hex string");

export const createMarketOnChainSchema = z.object({
  questionId: bytes32Schema.optional(),
  metadataURI: z.string().min(1).optional()
});

export const submitMarketResolutionOnChainSchema = z.object({
  questionId: bytes32Schema.optional()
});
