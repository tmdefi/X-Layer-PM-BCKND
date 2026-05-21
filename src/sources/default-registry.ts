import { createApiFootballSource } from "./api-football.js";
import { createHighlightlySource } from "./highlightly.js";
import { createPandaScoreSource } from "./pandascore.js";
import { SourceRegistry } from "./registry.js";

export function createDefaultSourceRegistry(): SourceRegistry {
  const registry = new SourceRegistry();
  const apiFootball = createApiFootballSource();

  if (apiFootball) {
    registry.register(apiFootball);
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
