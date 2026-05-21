import type {
  MarketDefinition,
  PlayerIdentity,
  ProviderFixtureResult,
  ResolutionDecision,
  ResolutionOutcome,
  Score
} from "./types.js";

export function resolveTotalGoals(score: Score, line: string): "UNDER" | "OVER" {
  const numericLine = Number(line);
  if (!Number.isFinite(numericLine)) {
    throw new Error(`Invalid total goals line: ${line}`);
  }

  return score.homeGoals + score.awayGoals > numericLine ? "OVER" : "UNDER";
}

export function resolveBothTeamsToScore(score: Score): "NO" | "YES" {
  return score.homeGoals > 0 && score.awayGoals > 0 ? "YES" : "NO";
}

export function resolveHomeTeamWin(score: Score): "NO" | "YES" {
  return score.homeGoals > score.awayGoals ? "YES" : "NO";
}

export function resolveDraw(score: Score): "NO" | "YES" {
  return score.homeGoals === score.awayGoals ? "YES" : "NO";
}

export function resolveAwayTeamWin(score: Score): "NO" | "YES" {
  return score.awayGoals > score.homeGoals ? "YES" : "NO";
}

export function isTie(score: Score): boolean {
  return score.homeGoals === score.awayGoals;
}

export function resolveMarket(market: MarketDefinition, score: Score): ResolutionOutcome {
  switch (market.type) {
    case "TOTAL_GOALS":
      return resolveTotalGoals(score, market.line);
    case "BOTH_TEAMS_TO_SCORE":
      return resolveBothTeamsToScore(score);
    case "YES_NO":
      throw new Error("YES_NO markets require an explicit oracle result");
  }
}

export function payoutVectorForOutcome(outcome: ResolutionOutcome): readonly [number, number] {
  switch (outcome) {
    case "NO":
    case "UNDER":
      return [1, 0];
    case "YES":
    case "OVER":
      return [0, 1];
    case "VOID":
      return [1, 1];
  }
}

export function computeResolutionDecision(
  market: MarketDefinition,
  result: ProviderFixtureResult,
  computedAt = new Date().toISOString()
): ResolutionDecision {
  if (result.status !== "finished") {
    throw new Error(`Cannot resolve market ${market.id}: fixture is ${result.status}`);
  }

  const outcome = computeOutcome(market, result);

  return {
    marketId: market.id,
    marketType: market.type,
    outcome,
    payoutVector: payoutVectorForOutcome(outcome),
    status: "computed",
    source: result.source,
    observedAt: result.observedAt,
    computedAt,
    reason: resolutionReason(market, result, outcome)
  };
}

function computeOutcome(market: MarketDefinition, result: ProviderFixtureResult): ResolutionOutcome {
  switch (market.type) {
    case "TOTAL_GOALS":
    case "BOTH_TEAMS_TO_SCORE":
      if (!result.score) {
        throw new Error(`Cannot resolve market ${market.id}: score is missing`);
      }
      return resolveMarket(market, result.score);
    case "YES_NO":
      if (market.resolver?.rule === "HOME_TEAM_WIN") {
        if (!result.score) {
          throw new Error(`Cannot resolve HOME_TEAM_WIN market ${market.id}: score is missing`);
        }
        if (isBasketballWinnerMarket(market) && isTie(result.score)) {
          return "VOID";
        }
        return resolveHomeTeamWin(result.score);
      }

      if (market.resolver?.rule === "DRAW") {
        if (!result.score) {
          throw new Error(`Cannot resolve DRAW market ${market.id}: score is missing`);
        }
        return resolveDraw(result.score);
      }

      if (market.resolver?.rule === "AWAY_TEAM_WIN") {
        if (!result.score) {
          throw new Error(`Cannot resolve AWAY_TEAM_WIN market ${market.id}: score is missing`);
        }
        if (isBasketballWinnerMarket(market) && isTie(result.score)) {
          return "VOID";
        }
        return resolveAwayTeamWin(result.score);
      }

      if (market.resolver?.rule === "FIRST_HALF_HOME_TEAM_WIN") {
        if (!result.halfTimeScore) {
          throw new Error(`Cannot resolve FIRST_HALF_HOME_TEAM_WIN market ${market.id}: half-time score is missing`);
        }
        return resolveHomeTeamWin(result.halfTimeScore);
      }

      if (market.resolver?.rule === "FIRST_HALF_DRAW") {
        if (!result.halfTimeScore) {
          throw new Error(`Cannot resolve FIRST_HALF_DRAW market ${market.id}: half-time score is missing`);
        }
        return resolveDraw(result.halfTimeScore);
      }

      if (market.resolver?.rule === "FIRST_HALF_AWAY_TEAM_WIN") {
        if (!result.halfTimeScore) {
          throw new Error(`Cannot resolve FIRST_HALF_AWAY_TEAM_WIN market ${market.id}: half-time score is missing`);
        }
        return resolveAwayTeamWin(result.halfTimeScore);
      }

      if (market.resolver?.rule === "HOME_TEAM_SCORE_FIRST") {
        if (result.homeTeamScoredFirst === undefined) {
          throw new Error(`Cannot resolve HOME_TEAM_SCORE_FIRST market ${market.id}: first-goal outcome is missing`);
        }
        return result.homeTeamScoredFirst ? "YES" : "NO";
      }

      if (market.resolver?.rule === "PLAYER_SCORED") {
        if (market.template?.category !== "MAIN_PLAYER") {
          throw new Error(`Cannot resolve PLAYER_SCORED market ${market.id}: player template is missing`);
        }
        if (!result.scoringPlayers && !result.scoringPlayerNames) {
          throw new Error(`Cannot resolve PLAYER_SCORED market ${market.id}: scoring player list is missing`);
        }
        return playerScored(result, market.template.player) ? "YES" : "NO";
      }

      if (!result.explicitOutcome) {
        throw new Error(`Cannot resolve YES_NO market ${market.id}: explicit outcome is missing`);
      }
      return result.explicitOutcome;
  }
}

function resolutionReason(
  market: MarketDefinition,
  result: ProviderFixtureResult,
  outcome: ResolutionOutcome
): string {
  if (market.type === "TOTAL_GOALS" && result.score) {
    const totalGoals = result.score.homeGoals + result.score.awayGoals;
    return `Final total ${totalGoals} vs line ${market.line}: ${outcome}`;
  }

  if (market.type === "BOTH_TEAMS_TO_SCORE" && result.score) {
    return `Final score ${result.score.homeGoals}-${result.score.awayGoals}: ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "HOME_TEAM_WIN" && result.score) {
    if (outcome === "VOID") {
      return `Final score ${result.score.homeGoals}-${result.score.awayGoals}: basketball tie voids home team win market`;
    }
    return `Final score ${result.score.homeGoals}-${result.score.awayGoals}: home team win ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "DRAW" && result.score) {
    return `Final score ${result.score.homeGoals}-${result.score.awayGoals}: draw ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "AWAY_TEAM_WIN" && result.score) {
    if (outcome === "VOID") {
      return `Final score ${result.score.homeGoals}-${result.score.awayGoals}: basketball tie voids away team win market`;
    }
    return `Final score ${result.score.homeGoals}-${result.score.awayGoals}: away team win ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "FIRST_HALF_HOME_TEAM_WIN" && result.halfTimeScore) {
    return `Half-time score ${result.halfTimeScore.homeGoals}-${result.halfTimeScore.awayGoals}: first-half home team win ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "FIRST_HALF_DRAW" && result.halfTimeScore) {
    return `Half-time score ${result.halfTimeScore.homeGoals}-${result.halfTimeScore.awayGoals}: first-half draw ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "FIRST_HALF_AWAY_TEAM_WIN" && result.halfTimeScore) {
    return `Half-time score ${result.halfTimeScore.homeGoals}-${result.halfTimeScore.awayGoals}: first-half away team win ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "HOME_TEAM_SCORE_FIRST") {
    return `First goal outcome: home team scored first ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "PLAYER_SCORED" && market.template?.category === "MAIN_PLAYER") {
    return `Scoring players: ${scoringPlayerLabels(result)}; ${market.template.player.playerName} scored ${outcome}`;
  }

  return `Explicit oracle outcome: ${outcome}`;
}

function isBasketballWinnerMarket(market: MarketDefinition): boolean {
  return (
    market.type === "YES_NO" &&
    market.source?.provider === "highlightly" &&
    (market.resolver?.rule === "HOME_TEAM_WIN" || market.resolver?.rule === "AWAY_TEAM_WIN")
  );
}

function playerScored(result: ProviderFixtureResult, player: PlayerIdentity): boolean {
  if (player.playerId && result.scoringPlayers) {
    return result.scoringPlayers.some((scorer) => scorer.provider === "api-football" && scorer.playerId === player.playerId);
  }

  const expected = normalizePlayerName(player.playerName);
  return (result.scoringPlayerNames ?? []).some((scorer) => normalizePlayerName(scorer) === expected);
}

function normalizePlayerName(playerName: string): string {
  return playerName.trim().toLowerCase().replace(/\s+/g, " ");
}

function scoringPlayerLabels(result: ProviderFixtureResult): string {
  const players = result.scoringPlayers?.map((player) => `${player.playerName}${player.playerId ? `#${player.playerId}` : ""}`);
  if (players && players.length > 0) return players.join(", ");
  return result.scoringPlayerNames?.join(", ") ?? "none";
}
