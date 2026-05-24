import { z } from "zod";

const optionalAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .optional()
  .or(z.literal(""));

const optionalPrivateKeySchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .optional()
  .or(z.literal(""));

const booleanEnvSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no", "off", ""].includes(value.toLowerCase())) return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_URL: z.string().url().optional().or(z.literal("")),
  DIRECT_URL: z.string().url().optional().or(z.literal("")),
  DATABASE_ENABLED: booleanEnvSchema.default(false),
  XLAYER_CHAIN_ID: z.coerce.number().int().positive().default(1952),
  XLAYER_RPC_URL: z.string().url().default("https://testrpc.xlayer.tech/terigon"),
  PRIVATE_KEY: optionalPrivateKeySchema,
  ADMIN_ADDRESS: optionalAddressSchema,
  COLLATERAL_TOKEN_ADDRESS: optionalAddressSchema,
  CONDITIONAL_TOKENS_ADDRESS: optionalAddressSchema,
  CTF_EXCHANGE_ADDRESS: optionalAddressSchema,
  MARKET_FACTORY_ADDRESS: optionalAddressSchema,
  BINARY_MARKET_RESOLVER_ADDRESS: optionalAddressSchema,
  CLOB_OPERATOR_API_KEY: z.string().min(16).optional().or(z.literal("")),
  CLOB_ORDER_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(60),
  CLOB_ORDER_RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
  CLOB_AUTO_MATCH_ENABLED: booleanEnvSchema.default(true),
  CLOB_AUTO_MATCH_MAX_MAKERS: z.coerce.number().int().min(1).max(100).default(10),
  HOUSE_LIQUIDITY_ENABLED: booleanEnvSchema.default(false),
  HOUSE_LIQUIDITY_PRIVATE_KEY: optionalPrivateKeySchema,
  HOUSE_LIQUIDITY_MAX_ORDER_USDC: z.coerce.number().positive().default(100),
  API_FOOTBALL_KEY: z.string().min(1).optional().or(z.literal("")),
  API_FOOTBALL_BASE_URL: z.string().url().default("https://v3.football.api-sports.io"),
  API_FOOTBALL_PLAYER_STATS_SEASON: z.coerce.number().int().positive().optional().or(z.literal("")),
  API_FOOTBALL_FEATURED_LEAGUE_IDS: z.string().min(1).default("1:2026"),
  API_FOOTBALL_SYNC_FIXTURE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  API_MMA_KEY: z.string().min(1).optional().or(z.literal("")),
  API_MMA_BASE_URL: z.string().url().default("https://v1.mma.api-sports.io"),
  API_MMA_PROMOTION_FILTER: z.string().min(1).default("UFC"),
  PANDASCORE_TOKEN: z.string().min(1).optional().or(z.literal("")),
  PANDASCORE_BASE_URL: z.string().url().default("https://api.pandascore.co"),
  PANDASCORE_SETTLEMENT_MAX_FIXTURES_PER_RUN: z.coerce.number().int().min(1).max(100).default(8),
  PANDASCORE_SETTLEMENT_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(300),
  HIGHLIGHTLY_API_KEY: z.string().min(1).optional().or(z.literal("")),
  HIGHLIGHTLY_BASE_URL: z.string().url().default("https://nba.highlightly.net"),
  HIGHLIGHTLY_RAPIDAPI_HOST: z.string().min(1).optional().or(z.literal("")),
  HIGHLIGHTLY_BASKETBALL_LEAGUE: z.string().min(1).default("NBA"),
  FIXTURE_INSIGHTS_CACHE_SCHEDULED_SECONDS: z.coerce.number().int().min(30).default(900),
  FIXTURE_INSIGHTS_CACHE_LIVE_SECONDS: z.coerce.number().int().min(10).max(120).default(60),
  FIXTURE_INSIGHTS_CACHE_FINISHED_SECONDS: z.coerce.number().int().min(300).default(21600),
  PLAYER_CANDIDATE_CACHE_SCHEDULED_SECONDS: z.coerce.number().int().min(300).default(21600),
  PLAYER_CANDIDATE_CACHE_NEAR_KICKOFF_SECONDS: z.coerce.number().int().min(300).default(3600),
  PLAYER_CANDIDATE_CACHE_NEAR_KICKOFF_WINDOW_MINUTES: z.coerce.number().int().min(0).max(1440).default(1440),
  SETTLEMENT_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(60).default(60),
  SETTLEMENT_WORKER_ENABLED: booleanEnvSchema.default(false),
  SETTLEMENT_SUBMIT_ON_CHAIN: booleanEnvSchema.default(false),
  SETTLEMENT_NEAR_KICKOFF_WINDOW_MINUTES: z.coerce.number().int().min(0).max(1440).default(180),
  SETTLEMENT_NEAR_KICKOFF_FALLBACK_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(300),
  OPERATOR_TX_RECOVERY_WORKER_ENABLED: booleanEnvSchema.default(true),
  OPERATOR_TX_RECOVERY_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  OPERATOR_TX_RECOVERY_LIMIT: z.coerce.number().int().min(1).max(500).default(100),
  SYNC_WORKER_ENABLED: booleanEnvSchema.default(true),
  SYNC_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(300),
  SYNC_CURRENT_FIXTURE_DAYS: z.coerce.number().int().min(1).max(90).default(3),
  SYNC_CREATE_MARKETS_ON_CHAIN: booleanEnvSchema.default(true),
  SYNC_ON_CHAIN_MARKET_LIMIT: z.coerce.number().int().min(1).max(500).default(50)
});

export const env = envSchema.parse(process.env);
