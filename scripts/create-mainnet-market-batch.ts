import "dotenv/config";
import { Client } from "pg";
import { createMarketOnChain, getMarketOnChain, marketQuestionId } from "../src/chain/markets.js";

type Candidate = {
  id: string;
  type: string;
  kickoffTime: Date | null;
  fixtureStatus: string | null;
};

const limit = positiveInt(process.env.CREATE_MAINNET_MARKET_LIMIT, 25);
const liveGraceHours = positiveInt(process.env.CREATE_MAINNET_LIVE_GRACE_HOURS, 6);
const cancelStaleOrders = process.env.CREATE_MAINNET_CANCEL_STALE_ORDERS === "true";
const sportFilter = optionalFilter(process.env.CREATE_MAINNET_MARKET_SPORT);
const competitionNameFilter = optionalFilter(process.env.CREATE_MAINNET_COMPETITION_NAME);
const matchOnly = process.env.CREATE_MAINNET_MATCH_ONLY === "true";
const missingOnly = process.env.CREATE_MAINNET_MISSING_ONLY === "true";
const databaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DIRECT_URL or DATABASE_URL is required");
}

const client = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

await client.connect();

try {
  const candidates = await listCandidates(client, liveGraceHours, {
    sport: sportFilter,
    competitionName: competitionNameFilter,
    matchOnly,
    missingOnly
  });
  const created: unknown[] = [];
  const recovered: unknown[] = [];
  const failed: unknown[] = [];
  let checked = 0;

  for (const market of candidates) {
    if (checked >= limit) break;
    checked += 1;

    try {
      const existing = await getMarketOnChain(market.id);
      const result = existing ?? await createMarketOnChain({
        marketId: market.id,
        questionId: marketQuestionId(market.id),
        marketType: market.type,
        metadataURI: `market:${market.id}`
      });

      if (!result.conditionId) throw new Error("MarketFactory did not return a conditionId");

      await markMarketOpen(client, market.id, result.conditionId);

      const entry = {
        marketId: market.id,
        conditionId: result.conditionId,
        transactionHash: "transactionHash" in result ? result.transactionHash : undefined
      };
      if (existing) recovered.push(entry);
      else created.push(entry);
    } catch (error) {
      failed.push({
        marketId: market.id,
        error: error instanceof Error ? error.message : String(error)
      });
      if (failed.length >= 10) break;
    }
  }

  const cancelledOrders = cancelStaleOrders ? await cancelOpenOrders(client) : 0;

  console.log(JSON.stringify({
    candidates: candidates.length,
    checked,
    limit,
    created: created.length,
    recovered: recovered.length,
    failed: failed.length,
    cancelledOrders,
    createdSample: created.slice(0, 10),
    recoveredSample: recovered.slice(0, 10),
    failedSample: failed.slice(0, 10)
  }, null, 2));
} finally {
  await client.end();
}

async function listCandidates(
  client: Client,
  graceHours: number,
  filters: { sport?: string; competitionName?: string; matchOnly: boolean; missingOnly: boolean }
) {
  const params = [String(graceHours)];
  const optionalWhere: string[] = [];

  if (filters.sport) {
    params.push(filters.sport);
    optionalWhere.push(`f.sport = $${params.length}`);
  }
  if (filters.competitionName) {
    params.push(`%${filters.competitionName}%`);
    optionalWhere.push(`f.competition->>'name' ILIKE $${params.length}`);
  }
  if (filters.matchOnly) {
    optionalWhere.push(`
      m."fixtureId" IS NOT NULL
      AND COALESCE(m.template->>'category', '') NOT IN ('PLAYER', 'MAIN_PLAYER', 'PLAYER_FUTURE')
    `);
  }
  if (filters.missingOnly) {
    optionalWhere.push(`
      (
        m."conditionId" IS NULL
        OR m."tradingStatus" <> 'open'
        OR m."tradingStatusReason" IS NOT NULL
      )
    `);
  }

  const { rows } = await client.query<Candidate>(`
    SELECT
      m.id,
      m.type,
      f."kickoffTime" AS "kickoffTime",
      f.status AS "fixtureStatus"
    FROM "Market" m
    LEFT JOIN "Fixture" f ON f.id = m."fixtureId"
    WHERE m.status = 'open'
      AND (
        m."fixtureId" IS NULL
        OR (
          f."kickoffTime" IS NOT NULL
          AND (
            (f.status = 'scheduled' AND f."kickoffTime" >= NOW())
            OR (f.status = 'live' AND f."kickoffTime" >= NOW() - ($1::text || ' hours')::interval)
          )
        )
      )
      ${optionalWhere.map((clause) => `AND (${clause})`).join("\n      ")}
    ORDER BY COALESCE(f."kickoffTime", '9999-12-31'::timestamp), m.id
  `, params);

  return rows;
}

async function markMarketOpen(client: Client, marketId: string, conditionId: string) {
  await client.query(`
    UPDATE "Market"
    SET
      "conditionId" = $1,
      "tradingStatus" = 'open',
      "tradingStatusReason" = NULL,
      "tradingStatusUpdatedAt" = NOW(),
      "updatedAt" = NOW()
    WHERE id = $2
  `, [conditionId, marketId]);
}

async function cancelOpenOrders(client: Client) {
  const result = await client.query(`
    UPDATE "ClobOrder"
    SET status = 'cancelled', "updatedAt" = NOW()
    WHERE status IN ('open', 'partially_filled')
  `);
  return result.rowCount ?? 0;
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalFilter(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
