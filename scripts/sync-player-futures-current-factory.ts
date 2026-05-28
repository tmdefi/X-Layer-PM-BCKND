import "dotenv/config";
import { createStore } from "../src/api/store.js";
import { createMarketOnChain, getMarketOnChain } from "../src/chain/markets.js";

const write = process.env.PLAYER_FUTURE_FACTORY_WRITE === "true";
const limit = Number(process.env.PLAYER_FUTURE_FACTORY_LIMIT ?? "25");
const store = await createStore();
const markets = store.listMarkets()
  .filter((market) => market.status === "open")
  .filter((market) => market.template?.category === "PLAYER_FUTURE")
  .sort((left, right) => left.id.localeCompare(right.id));

const alreadyCurrent: unknown[] = [];
const created: unknown[] = [];
const failed: unknown[] = [];

for (const market of markets) {
  if (write && created.length >= limit) break;

  try {
    const current = await getMarketOnChain(market.id);
    if (current?.conditionId) {
      if (market.conditionId !== current.conditionId && write) {
        store.updateMarket({ ...market, conditionId: current.conditionId });
      }
      alreadyCurrent.push({
        marketId: market.id,
        title: market.title,
        conditionId: current.conditionId,
        updatedDatabase: market.conditionId !== current.conditionId && write
      });
      continue;
    }

    if (!write) {
      created.push({
        marketId: market.id,
        title: market.title,
        action: "would_create"
      });
      continue;
    }

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
    created.push({
      marketId: market.id,
      title: market.title,
      conditionId: result.conditionId,
      transactionHash: result.transactionHash
    });
  } catch (error) {
    failed.push({
      marketId: market.id,
      title: market.title,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

if (write) {
  await store.waitForPendingWrites();
}

console.log(JSON.stringify({
  dryRun: !write,
  scanned: markets.length,
  alreadyCurrent: alreadyCurrent.length,
  created: created.length,
  failed: failed.length,
  limit,
  alreadyCurrentSample: alreadyCurrent.slice(0, 25),
  createdSample: created.slice(0, 25),
  failedSample: failed.slice(0, 25)
}, null, 2));
