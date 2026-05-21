import { createFootballFixtureMarkets } from "../markets/definitions.js";
import type { Fixture, FootballFixture, MarketDefinition } from "../markets/types.js";
import type { SourceRegistry } from "../sources/registry.js";
import type { FixtureQuery } from "../sources/types.js";

export type MarketIngestionInput = {
  provider: string;
  query: FixtureQuery;
  sourceRegistry: SourceRegistry;
};

export async function fetchFixturesFromSource(input: MarketIngestionInput): Promise<Fixture[]> {
  const source = input.sourceRegistry.get(input.provider);
  return source.listFixtures(input.query);
}

export async function createMarketsFromSource(input: MarketIngestionInput): Promise<MarketDefinition[]> {
  const fixtures = await fetchFixturesFromSource(input);

  return fixtures.flatMap((fixture) => {
    if (fixture.sport === "football") {
      return createFootballFixtureMarkets(fixture as FootballFixture);
    }

    return [];
  });
}
