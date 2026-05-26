if (process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

const { createStore } = await import("../src/api/store.js");
const { createMarketOnChain, getMarketOnChain } = await import("../src/chain/markets.js");

const batchSize = Number(process.env.RECOVERY_BATCH_FIXTURES ?? "5");
const createMissing = process.env.CREATE_MISSING_ONCHAIN !== "false";

const store = await createStore();
const fixtures = store.listFixtures()
  .filter((fixture) => fixture.sport === "football" && (fixture.status === "scheduled" || fixture.status === "live"))
  .sort((left, right) => Date.parse(left.kickoffTime) - Date.parse(right.kickoffTime));
const markets = store.listMarkets().filter((market) => market.status === "open" && market.fixtureId);
const batch = fixtures
  .map((fixture) => ({
    fixture,
    markets: markets.filter((market) => market.fixtureId === fixture.id)
  }))
  .filter((item) => item.markets.some((market) => !market.conditionId))
  .slice(0, batchSize);

const recovered: unknown[] = [];
const created: unknown[] = [];
const already: string[] = [];
const notFound: unknown[] = [];
const errors: unknown[] = [];

for (const item of batch) {
  for (const market of item.markets) {
    if (market.conditionId) {
      already.push(market.id);
      continue;
    }

    try {
      const onChain = await getMarketOnChain(market.id);
      if (onChain?.conditionId) {
        store.updateMarket({ ...market, conditionId: onChain.conditionId });
        recovered.push({
          fixture: `${item.fixture.homeCompetitor} vs ${item.fixture.awayCompetitor}`,
          marketId: market.id,
          conditionId: onChain.conditionId
        });
      } else if (createMissing) {
        const result = await createMarketOnChain({
          marketId: market.id,
          marketType: market.type,
          metadataURI: `market:${market.id}`
        });
        if (result.conditionId) {
          store.updateMarket({ ...market, conditionId: result.conditionId });
        }
        created.push({
          fixture: `${item.fixture.homeCompetitor} vs ${item.fixture.awayCompetitor}`,
          marketId: market.id,
          conditionId: result.conditionId,
          txHash: result.transactionHash
        });
      } else {
        notFound.push({
          fixture: `${item.fixture.homeCompetitor} vs ${item.fixture.awayCompetitor}`,
          marketId: market.id
        });
      }
    } catch (error) {
      errors.push({
        fixture: `${item.fixture.homeCompetitor} vs ${item.fixture.awayCompetitor}`,
        marketId: market.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

await store.waitForPendingWrites();

console.log(JSON.stringify({
  batchFixtures: batch.map((item) => `${item.fixture.homeCompetitor} vs ${item.fixture.awayCompetitor}`),
  recovered: recovered.length,
  created: created.length,
  already: already.length,
  notFound: notFound.length,
  errors,
  recoveredSample: recovered.slice(0, 8),
  createdSample: created.slice(0, 8),
  notFoundSample: notFound.slice(0, 8)
}, null, 2));
