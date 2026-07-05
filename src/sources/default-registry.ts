import { createApiFootballSource } from "./api-football.js";
import { createApiMmaSource } from "./api-mma.js";
import { createCricketDataSource } from "./cricket-data.js";
import { createFootballDataSource } from "./football-data.js";
import { createHighlightlySource } from "./highlightly.js";
import { createPandaScoreSource } from "./pandascore.js";
import { SourceRegistry } from "./registry.js";

export function createDefaultSourceRegistry(): SourceRegistry {
  const registry = new SourceRegistry();
  const footballData = createFootballDataSource();

  if (footballData) {
    registry.register(footballData);
  }

  const cricketData = createCricketDataSource();
  if (cricketData) {
    registry.register(cricketData);
  }

  const apiFootball = createApiFootballSource();

  if (apiFootball) {
    registry.register(apiFootball);
  }

  const apiMma = createApiMmaSource();
  if (apiMma) {
    registry.register(apiMma);
  }

  const pandaScore = createPandaScoreSource();
  if (pandaScore) {
    registry.register(pandaScore);
  }

  const highlightly = createHighlightlySource();
  if (highlightly) {
    registry.register(highlightly);
  }

  return registry;
}
