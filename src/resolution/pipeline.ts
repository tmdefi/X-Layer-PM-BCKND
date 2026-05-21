import { computeResolutionDecision } from "../markets/resolution.js";
import type { MarketDefinition, ResolutionDecision } from "../markets/types.js";
import type { SourceRegistry } from "../sources/registry.js";

export type ResolutionPipelineInput = {
  market: MarketDefinition;
  sourceRegistry: SourceRegistry;
  externalFixtureId: string;
};

export async function computeResolutionFromSource(
  input: ResolutionPipelineInput
): Promise<ResolutionDecision> {
  const provider = input.market.resolver?.source.provider ?? input.market.source?.provider;
  if (!provider) {
    throw new Error(`Market ${input.market.id} does not have a configured data source`);
  }

  const source = input.sourceRegistry.get(provider);
  const result = await source.getFixtureResult(input.externalFixtureId);
  if (input.market.fixtureId && result.fixtureId !== input.market.fixtureId) {
    throw new Error(
      `Source result fixture ${result.fixtureId} does not match market fixture ${input.market.fixtureId}`
    );
  }

  return computeResolutionDecision(input.market, result);
}

export function markResolutionReviewed(decision: ResolutionDecision): ResolutionDecision {
  return {
    ...decision,
    status: "reviewed"
  };
}

export function markResolutionSubmitted(decision: ResolutionDecision): ResolutionDecision {
  if (decision.status !== "reviewed") {
    throw new Error(`Resolution ${decision.marketId} must be reviewed before submission`);
  }

  return {
    ...decision,
    status: "submitted"
  };
}
