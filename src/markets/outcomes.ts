import type { OutcomeDefinition } from "./types.js";

export const YES_NO_OUTCOMES = [
  { side: "NO", indexSet: 1, label: "No" },
  { side: "YES", indexSet: 2, label: "Yes" }
] as const satisfies readonly [OutcomeDefinition, OutcomeDefinition];

export const TOTAL_GOALS_OUTCOMES = [
  { side: "UNDER", indexSet: 1, label: "Under" },
  { side: "OVER", indexSet: 2, label: "Over" }
] as const satisfies readonly [OutcomeDefinition, OutcomeDefinition];

export const BOTH_TEAMS_TO_SCORE_OUTCOMES = YES_NO_OUTCOMES;
