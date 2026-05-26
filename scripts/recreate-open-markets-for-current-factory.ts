import "dotenv/config";
import { createStore } from "../src/api/store.js";
import { createMarketOnChain, getMarketOnChain } from "../src/chain/markets.js";

const limit = Number(process.env.RECREATE_MARKET_LIMIT ?? process.env.SYNC_ON_CHAIN_MARKET_LIMIT ?? "50");
const currentOnly = process.env.RECREATE_CURRENT_ONLY !== "false";
const store = await createStore();
const now = Date.now();
const liveFixtureGraceMs = Number(process.env.RECREATE_LIVE_FIXTURE_GRACE_HOURS ?? "6") * 60 * 60 * 1000;
const markets = store.listMarkets()
  .filter((market) => market.status === "open")
  .filter((market) => {
    if (!currentOnly) return true;
    if (!market.fixtureId) return true;
    const fixture = store.getFixture(market.fixtureId);
    if (!fixture?.kickoffTime) return false;
    const kickoffTime = Date.parse(fixture.kickoffTime);
    if (!Number.isFinite(kickoffTime)) return false;
    if (fixture.status === "live") return kickoffTime >= now - liveFixtureGraceMs;
    if (fixture.status === "scheduled") return kickoffTime >= now;
    return false;
  })
  .sort((left, right) => {
    const leftFixture = left.fixtureId ? store.getFixture(left.fixtureId) : undefined;
    const rightFixture = right.fixtureId ? store.getFixture(right.fixtureId) : undefined;
    const leftTime = leftFixture?.kickoffTime ? Date.parse(leftFixture.kickoffTime) : Number.MAX_SAFE_INTEGER;
    const rightTime = rightFixture?.kickoffTime ? Date.parse(rightFixture.kickoffTime) : Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.id.localeCompare(right.id);
  });

let attemptedMissing = 0;
let alreadyCurrent = 0;
const created: unknown[] = [];
const recovered: unknown[] = [];
const failed: unknown[] = [];

for (const market of markets) {
  if (attemptedMissing >= limit) break;

  try {
    const existing = await getMarketOnChain(market.id);
    if (existing) {
      store.updateMarket({
        ...market,
        conditionId: existing.conditionId
      });
      recovered.push({
        marketId: market.id,
        conditionId: existing.conditionId,
        token0: existing.token0,
        token1: existing.token1
      });
      alreadyCurrent += 1;
      continue;
    }

    attemptedMissing += 1;

    const result = await createMarketOnChain({
      marketId: market.id,
      marketType: market.type,
      metadataURI: `market:${market.id}`
    });
    if (!result.conditionId) throw new Error("MarketFactory did not return a conditionId");

    store.updateMarket({
      ...market,
      conditionId: result.conditionId
    });

    const entry = {
      marketId: market.id,
      conditionId: result.conditionId,
      token0: result.token0,
      token1: result.token1,
      transactionHash: "transactionHash" in result ? result.transactionHash : undefined
    };
    created.push(entry);
  } catch (error) {
    failed.push({
      marketId: market.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

for (const order of store.listClobOrders()) {
  if (order.status !== "open" && order.status !== "partially_filled") continue;
  store.upsertClobOrder({
    ...order,
    status: "cancelled",
    updatedAt: new Date().toISOString()
  });
}

await store.waitForPendingWrites();

console.log(JSON.stringify({
  scanned: markets.length,
  alreadyCurrent,
  attemptedMissing,
  created: created.length,
  recovered: recovered.length,
  failed: failed.length,
  createdSample: created.slice(0, 10),
  recoveredSample: recovered.slice(0, 10),
  failedSample: failed.slice(0, 10)
}, null, 2));
