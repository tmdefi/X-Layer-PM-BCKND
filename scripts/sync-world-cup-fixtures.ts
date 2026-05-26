import "dotenv/config";
import { createStore } from "../src/api/store.js";
import { createFootballFixtureMarkets } from "../src/markets/definitions.js";
import type { FootballFixture } from "../src/markets/types.js";
import { createDefaultSourceRegistry } from "../src/sources/index.js";

const days = Number(process.env.WORLD_CUP_SYNC_DAYS ?? "90");
const leagueId = process.env.WORLD_CUP_LEAGUE_ID ?? "1";
const season = process.env.WORLD_CUP_SEASON ?? "2026";
const now = new Date();
const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days - 1));
const fromDate = now.toISOString().slice(0, 10);
const toDate = to.toISOString().slice(0, 10);

const store = await createStore();
const source = createDefaultSourceRegistry().get("api-football");
const fixtures = (await source.listFixtures({
  sport: "football",
  from: fromDate,
  to: toDate,
  leagueId,
  season
}))
  .filter((fixture): fixture is FootballFixture => fixture.sport === "football")
  .filter((fixture) => fixture.status === "scheduled" || fixture.status === "live")
  .sort((left, right) => Date.parse(left.kickoffTime) - Date.parse(right.kickoffTime));

const existingFixtureIds = new Set(store.listFixtures().map((fixture) => fixture.id));
const markets = fixtures.flatMap((fixture) => createFootballFixtureMarkets(fixture, { status: "open" }));
const existingMarketIds = new Set(store.listMarkets().map((market) => market.id));

store.upsertFixtures(fixtures);
store.upsertMarkets(markets);
await store.waitForPendingWrites();

console.log(JSON.stringify({
  leagueId,
  season,
  from: fromDate,
  to: toDate,
  fixtures: fixtures.length,
  newFixtures: fixtures.filter((fixture) => !existingFixtureIds.has(fixture.id)).length,
  markets: markets.length,
  newMarkets: markets.filter((market) => !existingMarketIds.has(market.id)).length,
  firstFixture: fixtures[0],
  lastFixture: fixtures[fixtures.length - 1]
}, null, 2));
