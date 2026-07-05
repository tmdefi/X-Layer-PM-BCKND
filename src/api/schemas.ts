import { z } from "zod";
import { PLAYER_TOURNAMENT_FUTURE_OVER_LINES } from "../markets/definitions.js";

export const sportSchema = z.enum(["football", "basketball", "american_football", "esports", "mma", "cricket", "tennis"]);

export const fixtureStatusSchema = z.enum([
  "scheduled",
  "live",
  "finished",
  "postponed",
  "cancelled",
  "abandoned"
]);

export const marketStatusSchema = z.enum(["draft", "open", "closed", "resolved", "cancelled"]);
export const marketTradingStatusSchema = z.enum(["open", "suspended", "closed"]);
export const marketTypeSchema = z.enum(["YES_NO", "TOTAL_GOALS", "BOTH_TEAMS_TO_SCORE"]);

export const playerMarketTemplateSchema = z.enum(["HAT_TRICK", "YELLOW_CARD"]);
export const mainCardPlayerMarketTemplateSchema = z.enum(["ANYTIME_GOALSCORER"]);
export const playerTournamentFutureTemplateSchema = z.enum([
  "TOURNAMENT_GOALS_OVER",
  "TOURNAMENT_ASSISTS_OVER",
  "TOURNAMENT_CARDS_OVER",
  "TOURNAMENT_FOULS_OVER",
  "TOURNAMENT_FREE_KICK_GOAL"
]);
export const playerTournamentFutureOverLineSchema = z.enum(PLAYER_TOURNAMENT_FUTURE_OVER_LINES);
export const teamSideSchema = z.enum(["home", "away"]);

export const playerIdentityInputSchema = z.object({
  playerId: z.string().min(1).optional(),
  playerName: z.string().min(1),
  teamSide: teamSideSchema.optional(),
  teamName: z.string().min(1).optional(),
  imageUrl: z.string().url().optional()
});

export const dataSourceRefSchema = z.object({
  provider: z.string().min(1),
  externalFixtureId: z.string().min(1).optional(),
  externalMarketId: z.string().min(1).optional(),
  sourceUrl: z.string().url().optional(),
  fetchedAt: z.string().datetime().optional()
});

export const competitionRefSchema = z.object({
  kind: z.enum(["league", "tournament", "competition"]),
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  season: z.string().min(1).optional()
});

export const fixtureSchema = z.object({
  id: z.string().min(1),
  sport: sportSchema,
  source: dataSourceRefSchema,
  competition: competitionRefSchema.optional(),
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
        "PLAYER_TOURNAMENT_STAT",
        "EXPLICIT_YES_NO"
      ]),
      source: dataSourceRefSchema
    })
    .optional()
});

export const generateFixtureMarketsSchema = z.object({
  status: marketStatusSchema.optional(),
  tradingStatus: marketTradingStatusSchema.optional(),
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

export const createPlayerTournamentFuturesSchema = z.object({
  status: marketStatusSchema.optional(),
  provider: z.string().min(1).default("api-football"),
  competition: competitionRefSchema,
  markets: z
    .array(
      z.object({
        playerId: z.string().min(1).optional(),
        playerName: z.string().min(1),
        teamName: z.string().min(1).optional(),
        imageUrl: z.string().url().optional(),
        template: playerTournamentFutureTemplateSchema,
        line: playerTournamentFutureOverLineSchema.optional()
      })
    )
    .min(1)
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
  days: z.coerce.number().int().min(1).max(90).default(3),
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
  tournamentPlayerStats: z.array(z.object({
    provider: z.string().min(1),
    playerId: z.string().min(1).optional(),
    playerName: z.string().min(1),
    goals: z.number().min(0).optional(),
    assists: z.number().min(0).optional(),
    cards: z.number().min(0).optional(),
    yellowCards: z.number().min(0).optional(),
    redCards: z.number().min(0).optional(),
    foulsCommitted: z.number().min(0).optional(),
    freeKickGoals: z.number().min(0).optional()
  })).optional(),
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

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Expected EVM address");
export const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "Expected hex string");
const uintStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, "Expected unsigned integer string");

export const clobOrderSideSchema = z.enum(["BUY", "SELL"]);
export const binaryOutcomeSideSchema = z.enum(["NO", "YES", "UNDER", "OVER"]);

export const exchangeOrderSchema = z.object({
  salt: uintStringSchema,
  maker: addressSchema,
  signer: addressSchema,
  taker: addressSchema,
  tokenId: uintStringSchema,
  makerAmount: uintStringSchema.refine((value) => BigInt(value) > 0n, "makerAmount must be positive"),
  takerAmount: uintStringSchema.refine((value) => BigInt(value) > 0n, "takerAmount must be positive"),
  expiration: uintStringSchema,
  nonce: uintStringSchema,
  feeRateBps: uintStringSchema,
  side: z.union([z.literal(0), z.literal(1)]),
  signatureType: z.union([z.literal(0), z.literal(1)]),
  signature: hexSchema
});

export const prepareClobOrderSchema = z.object({
  marketId: z.string().min(1),
  outcomeSide: binaryOutcomeSideSchema,
  maker: addressSchema,
  signer: addressSchema.optional(),
  taker: addressSchema.optional(),
  side: clobOrderSideSchema,
  makerAmount: uintStringSchema.refine((value) => BigInt(value) > 0n, "makerAmount must be positive"),
  takerAmount: uintStringSchema.refine((value) => BigInt(value) > 0n, "takerAmount must be positive"),
  expiration: uintStringSchema.optional(),
  feeRateBps: uintStringSchema.optional(),
  signatureType: z.union([z.literal(0), z.literal(1)]).optional()
});

export const clobOrderReadinessSchema = prepareClobOrderSchema.pick({
  marketId: true,
  outcomeSide: true,
  maker: true,
  side: true,
  makerAmount: true
});

export const submitClobOrderSchema = z.object({
  marketId: z.string().min(1),
  outcomeSide: binaryOutcomeSideSchema,
  order: exchangeOrderSchema
});

export const matchClobOrdersSchema = z.object({
  takerOrderId: z.string().min(1),
  makerOrderIds: z.array(z.string().min(1)).min(1),
  takerFillAmount: uintStringSchema.refine((value) => BigInt(value) > 0n, "takerFillAmount must be positive"),
  makerFillAmounts: z.array(uintStringSchema.refine((value) => BigInt(value) > 0n, "maker fill must be positive")).min(1)
}).refine((input) => input.makerOrderIds.length === input.makerFillAmounts.length, {
  message: "makerOrderIds and makerFillAmounts must have the same length",
  path: ["makerFillAmounts"]
});

export const tickClobMatcherSchema = z.object({
  marketId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const telegramUserSchema = z.object({
  telegramUserId: z.string().trim().min(1).max(64),
  username: z.string().trim().min(1).max(64).optional(),
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  photoUrl: z.string().url().optional()
});

export const telegramPlaceOrderSchema = telegramUserSchema.extend({
  marketId: z.string().min(1),
  outcomeSide: binaryOutcomeSideSchema,
  side: clobOrderSideSchema,
  makerAmount: uintStringSchema.refine((value) => BigInt(value) > 0n, "makerAmount must be positive"),
  takerAmount: uintStringSchema.refine((value) => BigInt(value) > 0n, "takerAmount must be positive"),
  expiration: uintStringSchema.optional(),
  feeRateBps: uintStringSchema.optional()
});

export const telegramClaimWinningsSchema = telegramUserSchema.extend({
  marketId: z.string().min(1)
});

export const telegramWithdrawalSchema = telegramUserSchema.extend({
  destination: addressSchema,
  amount: uintStringSchema.refine((value) => BigInt(value) > 0n, "amount must be positive")
});

export const portfolioQuerySchema = z.object({
  marketIds: z.string().min(1).optional().transform((value) =>
    value?.split(",").map((id) => id.trim()).filter(Boolean)
  )
});

export const marketTradesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

export const marketChartQuerySchema = z.object({
  interval: z.enum(["1m", "5m", "15m", "1h", "1d"]).default("15m"),
  limit: z.coerce.number().int().min(1).max(1_000).default(500)
});

export const marketListQuerySchema = z.object({
  q: z.string().trim().min(1).max(160).optional(),
  fixtureId: z.string().min(1).optional(),
  sport: sportSchema.optional(),
  status: marketStatusSchema.optional(),
  tradingStatus: marketTradingStatusSchema.optional(),
  provider: z.string().trim().min(1).max(80).optional(),
  fixtureStatus: fixtureStatusSchema.optional(),
  marketType: marketTypeSchema.optional(),
  category: z.enum(["match", "player", "main_player", "standalone"]).optional(),
  competitionId: z.string().trim().min(1).max(120).optional(),
  competitionName: z.string().trim().min(1).max(160).optional(),
  sort: z.enum(["kickoff_time", "live_status", "volume", "newest_activity"]).default("kickoff_time"),
  direction: z.enum(["asc", "desc"]).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});
