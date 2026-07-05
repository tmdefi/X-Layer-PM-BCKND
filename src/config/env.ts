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
  ARC_CHAIN_ID: z.coerce.number().int().positive().default(5042002),
  ARC_RPC_URL: z.string().url().default("https://arc-testnet.drpc.org"),
  ARC_EXPLORER_URL: z.string().url().default("https://testnet.arcscan.app"),
  ARC_CHAIN_NAME: z.string().min(1).default("Arc Testnet"),
  ARC_NATIVE_CURRENCY_NAME: z.string().min(1).default("USDC"),
  ARC_NATIVE_CURRENCY_SYMBOL: z.string().min(1).default("USDC"),
  ARC_NATIVE_CURRENCY_DECIMALS: z.coerce.number().int().min(0).max(255).default(18),
  PRIVATE_KEY: optionalPrivateKeySchema,
  ADMIN_ADDRESS: optionalAddressSchema,
  USDC_TOKEN_ADDRESS: optionalAddressSchema.default("0x3600000000000000000000000000000000000000"),
  CONDITIONAL_TOKENS_ADDRESS: optionalAddressSchema,
  CTF_EXCHANGE_ADDRESS: optionalAddressSchema,
  MARKET_FACTORY_ADDRESS: optionalAddressSchema,
  BINARY_MARKET_RESOLVER_ADDRESS: optionalAddressSchema,
  MARKET_QUESTION_ID_SALT: z.string().optional().default(""),
  CLOB_OPERATOR_API_KEY: z.string().min(16).optional().or(z.literal("")),
  CLOB_ORDER_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(60),
  CLOB_ORDER_RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
  CLOB_AUTO_MATCH_ENABLED: booleanEnvSchema.default(true),
  CLOB_AUTO_MATCH_MAX_MAKERS: z.coerce.number().int().min(1).max(100).default(10),
  TELEGRAM_BOT_API_KEY: z.string().min(16).optional().or(z.literal("")),
  PRIVY_SERVER_WALLETS_ENABLED: booleanEnvSchema.default(false),
  PRIVY_APP_ID: z.string().min(1).optional().or(z.literal("")),
  PRIVY_APP_SECRET: z.string().min(1).optional().or(z.literal("")),
  PRIVY_WALLET_SIGNER_ID: z.string().min(1).optional().or(z.literal("")),
  PRIVY_WALLET_AUTHORIZATION_PRIVATE_KEY: z.string().min(1).optional().or(z.literal("")),
  PRIVY_WALLET_POLICY_ID: z.string().min(1).optional().or(z.literal("")),
  HOUSE_LIQUIDITY_ENABLED: booleanEnvSchema.default(false),
  HOUSE_LIQUIDITY_PRIVATE_KEY: optionalPrivateKeySchema,
  LIQUIDITY_PROVIDER_PRIVATE_KEY: optionalPrivateKeySchema,
  LIQUIDITY_PROVIDER_ADDRESS: optionalAddressSchema,
  HOUSE_LIQUIDITY_MAX_ORDER_USDC: z.coerce.number().positive().default(100),
  HOUSE_LIQUIDITY_SPREAD_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
  API_FOOTBALL_KEY: z.string().min(1).optional().or(z.literal("")),
  API_FOOTBALL_BASE_URL: z.string().url().default("https://v3.football.api-sports.io"),
  API_FOOTBALL_PLAYER_STATS_SEASON: z.coerce.number().int().positive().optional().or(z.literal("")),
  API_FOOTBALL_FEATURED_LEAGUE_IDS: z.string().min(1).default("39:2026,140:2026,78:2026,135:2026,61:2026,2:2026"),
  API_FOOTBALL_FRIENDLY_LEAGUE_IDS: z.string().default("10:2026,667:2026"),
  API_FOOTBALL_SYNC_FIXTURE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  FOOTBALL_MATCH_PROVIDER: z.enum(["api-football", "football-data"]).default("football-data"),
  FOOTBALL_DATA_TOKEN: z.string().min(1).optional().or(z.literal("")),
  FOOTBALL_DATA_BASE_URL: z.string().url().default("https://api.football-data.org/v4"),
  FOOTBALL_DATA_FEATURED_COMPETITIONS: z.string().min(1).default("PL:2026,PD:2026,BL1:2026,SA:2026,FL1:2026"),
  FOOTBALL_DATA_SYNC_FIXTURE_DAYS: z.coerce.number().int().min(1).max(365).default(120),
  CRICKET_DATA_API_KEY: z.string().min(1).optional().or(z.literal("")),
  CRICKET_DATA_BASE_URL: z.string().url().default("https://api.cricapi.com/v1"),
  CRICKET_DATA_SYNC_FIXTURE_DAYS: z.coerce.number().int().min(1).max(365).default(365),
  CRICKET_DATA_SYNC_FIXTURE_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  THE_ODDS_API_KEY: z.string().min(1).optional().or(z.literal("")),
  THE_ODDS_API_BASE_URL: z.string().url().default("https://api.the-odds-api.com/v4"),
  THE_ODDS_API_TENNIS_SPORT_KEYS: z.string().min(1).default("tennis_atp_wimbledon,tennis_wta_wimbledon"),
  THE_ODDS_API_TENNIS_SYNC_FIXTURE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  THE_ODDS_API_TENNIS_SYNC_FIXTURE_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
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
  SYNC_ON_CHAIN_MARKET_LIMIT: z.coerce.number().int().min(1).max(500).default(150),
  SYNC_ON_CHAIN_RPC_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(350),
  MARKET_CARD_RPC_CONCURRENCY: z.coerce.number().int().min(1).max(12).default(3)
});

export const env = envSchema.parse(process.env);
