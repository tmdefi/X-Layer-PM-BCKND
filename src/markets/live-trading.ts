import type { MarketDefinition, PlayerIdentity, ProviderFixtureResult } from "./types.js";

export function footballLiveTradingCloseReason(
  market: MarketDefinition,
  result: ProviderFixtureResult
): string | undefined {
  if (market.tradingStatus !== "open" || !isFootballMarket(market)) return undefined;

  if (isFirstHalfMarket(market) && result.halfTimeScore) {
    return "First-half result is known";
  }

  if (market.resolver?.rule === "HOME_TEAM_SCORE_FIRST" && scoreTotal(result) > 0) {
    return "First goal is known";
  }

  if (market.type === "BOTH_TEAMS_TO_SCORE" && result.score?.homeGoals && result.score.awayGoals) {
    return "Both teams have scored";
  }

  if (market.type === "TOTAL_GOALS" && result.score && scoreTotal(result) > Number(market.line)) {
    return `Total goals already exceed line ${market.line}`;
  }

  if (market.resolver?.rule === "PLAYER_SCORED" && playerAlreadyScored(market, result)) {
    return "Player has already scored";
  }

  return undefined;
}

function isFootballMarket(market: MarketDefinition): boolean {
  return market.type === "TOTAL_GOALS"
    || market.type === "BOTH_TEAMS_TO_SCORE"
    || market.source?.provider === "api-football"
    || market.resolver?.source.provider === "api-football";
}

function isFirstHalfMarket(market: MarketDefinition): boolean {
  return market.resolver?.rule === "FIRST_HALF_HOME_TEAM_WIN"
    || market.resolver?.rule === "FIRST_HALF_DRAW"
    || market.resolver?.rule === "FIRST_HALF_AWAY_TEAM_WIN";
}

function scoreTotal(result: ProviderFixtureResult): number {
  return result.score ? result.score.homeGoals + result.score.awayGoals : 0;
}

function playerAlreadyScored(market: MarketDefinition, result: ProviderFixtureResult): boolean {
  if (market.template?.category !== "MAIN_PLAYER") return false;
  const player = market.template.player;

  return scorerIdentityMatch(player, result.scoringPlayers)
    || scorerNameMatch(player.playerName, result.scoringPlayerNames);
}

function scorerIdentityMatch(player: PlayerIdentity, scorers?: PlayerIdentity[]): boolean {
  if (!player.playerId || !scorers) return false;
  return scorers.some((scorer) =>
    scorer.provider === player.provider && scorer.playerId === player.playerId
  );
}

function scorerNameMatch(playerName: string, scorerNames?: string[]): boolean {
  if (!scorerNames) return false;
  return scorerNames.some((scorerName) => scorerName.toLowerCase() === playerName.toLowerCase());
}
