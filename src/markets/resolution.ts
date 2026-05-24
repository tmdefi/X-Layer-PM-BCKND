import type {
  MarketDefinition,
  EarlyResolutionConfirmation,
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

export function computeEarlyResolutionDecision(
  market: MarketDefinition,
  result: ProviderFixtureResult,
  computedAt = new Date().toISOString()
): ResolutionDecision | undefined {
  if (result.status !== "live") return undefined;

  const outcome = irreversibleLiveOutcome(market, result);
  if (!outcome) return undefined;
  const earlyResolution = earlyResolutionConfirmation(market, result, outcome);
  if (!earlyResolution) return undefined;

  return {
    marketId: market.id,
    marketType: market.type,
    outcome,
    payoutVector: payoutVectorForOutcome(outcome),
    status: "computed",
    source: result.source,
    observedAt: result.observedAt,
    computedAt,
    reason: earlyResolutionReason(market, result, outcome),
    earlyResolution
  };
}

export function confirmEarlyResolutionDecision(
  existing: ResolutionDecision | undefined,
  observed: ResolutionDecision,
  confirmedAt = new Date().toISOString()
): ResolutionDecision {
  const observation = observed.earlyResolution;
  if (!observation) return observed;

  const previous = existing?.earlyResolution;
  if (
    !previous ||
    existing?.outcome !== observed.outcome ||
    previous.policy !== observation.policy ||
    previous.evidenceKey !== observation.evidenceKey
  ) {
    return observed;
  }

  const repeated = previous.lastObservedAt !== observation.lastObservedAt;
  const observationCount = previous.observationCount + (repeated ? 1 : 0);
  return {
    ...observed,
    earlyResolution: {
      ...observation,
      observationCount,
      firstObservedAt: previous.firstObservedAt,
      ...(observationCount >= 2 ? { confirmedAt } : {})
    }
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
        if (isPandaScoreWinnerMarket(market) && result.explicitOutcome) {
          return result.explicitOutcome;
        }
        if (!result.score) {
          throw new Error(`Cannot resolve HOME_TEAM_WIN market ${market.id}: score is missing`);
        }
        if (isTieVoidWinnerMarket(market) && isTie(result.score)) {
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
        if (isPandaScoreWinnerMarket(market) && result.explicitOutcome) {
          return invertYesNoOutcome(result.explicitOutcome);
        }
        if (!result.score) {
          throw new Error(`Cannot resolve AWAY_TEAM_WIN market ${market.id}: score is missing`);
        }
        if (isTieVoidWinnerMarket(market) && isTie(result.score)) {
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

      if (market.resolver?.rule === "PLAYER_TOURNAMENT_STAT") {
        if (market.template?.category !== "PLAYER_FUTURE") {
          throw new Error(`Cannot resolve PLAYER_TOURNAMENT_STAT market ${market.id}: player future template is missing`);
        }
        const stat = tournamentStatForPlayer(result, market.template.player);
        if (!stat) {
          throw new Error(`Cannot resolve PLAYER_TOURNAMENT_STAT market ${market.id}: tournament player stat is missing`);
        }
        return resolveTournamentPlayerFuture(market, stat) ? "YES" : "NO";
      }

      if (!result.explicitOutcome) {
        throw new Error(`Cannot resolve YES_NO market ${market.id}: explicit outcome is missing`);
      }
      return result.explicitOutcome;
  }
}

function irreversibleLiveOutcome(market: MarketDefinition, result: ProviderFixtureResult): ResolutionOutcome | undefined {
  if (market.type === "TOTAL_GOALS" && result.score) {
    return result.score.homeGoals + result.score.awayGoals > Number(market.line) ? "OVER" : undefined;
  }

  if (market.type === "BOTH_TEAMS_TO_SCORE" && result.score) {
    return result.score.homeGoals > 0 && result.score.awayGoals > 0 ? "YES" : undefined;
  }

  if (market.type !== "YES_NO") return undefined;

  if (market.resolver?.rule === "HOME_TEAM_SCORE_FIRST") {
    if (result.homeTeamScoredFirst === undefined || !result.score || result.score.homeGoals + result.score.awayGoals === 0) {
      return undefined;
    }
    return result.homeTeamScoredFirst ? "YES" : "NO";
  }

  if (market.resolver?.rule === "PLAYER_SCORED" && market.template?.category === "MAIN_PLAYER") {
    return playerScoredWithStableIdentity(result, market.template.player) ? "YES" : undefined;
  }

  return undefined;
}

function earlyResolutionConfirmation(
  market: MarketDefinition,
  result: ProviderFixtureResult,
  outcome: ResolutionOutcome
): EarlyResolutionConfirmation | undefined {
  const base = {
    observationCount: 1,
    firstObservedAt: result.observedAt,
    lastObservedAt: result.observedAt
  };

  if (market.type === "TOTAL_GOALS" || market.type === "BOTH_TEAMS_TO_SCORE") {
    return {
      ...base,
      policy: "REPEATED_SCORE",
      evidenceKey: `${market.id}:${outcome}`
    };
  }

  if (market.type !== "YES_NO") return undefined;

  if (market.resolver?.rule === "HOME_TEAM_SCORE_FIRST" && result.homeTeamScoredFirst !== undefined) {
    return {
      ...base,
      policy: "STABLE_FIRST_GOAL",
      evidenceKey: `${market.id}:${result.homeTeamScoredFirst ? "home" : "away"}`
    };
  }

  if (market.resolver?.rule === "PLAYER_SCORED" && market.template?.category === "MAIN_PLAYER") {
    const player = market.template.player;
    if (!player.playerId) return undefined;
    return {
      ...base,
      policy: "STABLE_PLAYER_SCORER",
      evidenceKey: `${market.id}:${player.provider}:${player.playerId}`
    };
  }

  return undefined;
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
      return `Final score ${result.score.homeGoals}-${result.score.awayGoals}: tied winner result voids home team win market`;
    }
    return `Final score ${result.score.homeGoals}-${result.score.awayGoals}: home team win ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "DRAW" && result.score) {
    return `Final score ${result.score.homeGoals}-${result.score.awayGoals}: draw ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "AWAY_TEAM_WIN" && result.score) {
    if (outcome === "VOID") {
      return `Final score ${result.score.homeGoals}-${result.score.awayGoals}: tied winner result voids away team win market`;
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

  if (market.type === "YES_NO" && market.resolver?.rule === "PLAYER_TOURNAMENT_STAT" && market.template?.category === "PLAYER_FUTURE") {
    const stat = tournamentStatForPlayer(result, market.template.player);
    return `Tournament player stat for ${market.template.player.playerName}: ${tournamentFutureStatLabel(market, stat)} => ${outcome}`;
  }

  return `Explicit oracle outcome: ${outcome}`;
}

function earlyResolutionReason(
  market: MarketDefinition,
  result: ProviderFixtureResult,
  outcome: ResolutionOutcome
): string {
  if (market.type === "TOTAL_GOALS" && result.score) {
    const totalGoals = result.score.homeGoals + result.score.awayGoals;
    return `Irreversible live total ${totalGoals} exceeds line ${market.line}: ${outcome}`;
  }

  if (market.type === "BOTH_TEAMS_TO_SCORE" && result.score) {
    return `Irreversible live score ${result.score.homeGoals}-${result.score.awayGoals}: ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "HOME_TEAM_SCORE_FIRST") {
    return `Irreversible live first-goal outcome: home team scored first ${outcome}`;
  }

  if (market.type === "YES_NO" && market.resolver?.rule === "PLAYER_SCORED" && market.template?.category === "MAIN_PLAYER") {
    return `Irreversible live scorer event: ${market.template.player.playerName} scored ${outcome}`;
  }

  return `Irreversible live outcome: ${outcome}`;
}

function isTieVoidWinnerMarket(market: MarketDefinition): boolean {
  return (
    market.type === "YES_NO" &&
    (market.source?.provider === "highlightly" || market.source?.provider === "api-mma") &&
    (market.resolver?.rule === "HOME_TEAM_WIN" || market.resolver?.rule === "AWAY_TEAM_WIN")
  );
}

function isPandaScoreWinnerMarket(market: MarketDefinition): boolean {
  return (
    market.type === "YES_NO" &&
    market.resolver?.source.provider === "pandascore" &&
    (market.resolver.rule === "HOME_TEAM_WIN" || market.resolver.rule === "AWAY_TEAM_WIN")
  );
}

function invertYesNoOutcome(outcome: ResolutionOutcome): ResolutionOutcome {
  if (outcome === "YES") return "NO";
  if (outcome === "NO") return "YES";
  return outcome;
}

function playerScored(result: ProviderFixtureResult, player: PlayerIdentity): boolean {
  if (player.playerId && result.scoringPlayers) {
    return result.scoringPlayers.some((scorer) =>
      scorer.provider === player.provider && scorer.playerId === player.playerId
    );
  }

  const expected = normalizePlayerName(player.playerName);
  return (result.scoringPlayerNames ?? []).some((scorer) => normalizePlayerName(scorer) === expected);
}

function playerScoredWithStableIdentity(result: ProviderFixtureResult, player: PlayerIdentity): boolean {
  if (!player.playerId || !result.scoringPlayers) return false;

  return result.scoringPlayers.some((scorer) =>
    Boolean(scorer.playerId) &&
    scorer.provider === player.provider &&
    scorer.playerId === player.playerId
  );
}

function tournamentStatForPlayer(result: ProviderFixtureResult, player: PlayerIdentity) {
  const stats = result.tournamentPlayerStats ?? [];
  if (player.playerId) {
    const idMatch = stats.find((stat) => stat.provider === player.provider && stat.playerId === player.playerId);
    if (idMatch) return idMatch;
  }

  const expected = normalizePlayerName(player.playerName);
  return stats.find((stat) =>
    stat.provider === player.provider &&
    normalizePlayerName(stat.playerName) === expected
  );
}

function resolveTournamentPlayerFuture(
  market: MarketDefinition & { type: "YES_NO" },
  stat: NonNullable<ProviderFixtureResult["tournamentPlayerStats"]>[number]
): boolean {
  if (market.template?.category !== "PLAYER_FUTURE") {
    throw new Error(`Cannot resolve tournament player future ${market.id}: template is missing`);
  }

  switch (market.template.template) {
    case "TOURNAMENT_GOALS_OVER":
      return statValue(stat.goals) > futureLine(market);
    case "TOURNAMENT_ASSISTS_OVER":
      return statValue(stat.assists) > futureLine(market);
    case "TOURNAMENT_CARDS_OVER":
      return statValue(stat.cards ?? statValue(stat.yellowCards) + statValue(stat.redCards)) > futureLine(market);
    case "TOURNAMENT_FOULS_OVER":
      return statValue(stat.foulsCommitted) > futureLine(market);
    case "TOURNAMENT_FREE_KICK_GOAL":
      return statValue(stat.freeKickGoals) > 0;
  }
}

function futureLine(market: MarketDefinition): number {
  const line = market.template?.category === "PLAYER_FUTURE" ? Number(market.template.line) : NaN;
  if (!Number.isFinite(line)) {
    throw new Error(`Cannot resolve tournament player future ${market.id}: line is missing`);
  }
  return line;
}

function statValue(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function tournamentFutureStatLabel(
  market: MarketDefinition,
  stat: NonNullable<ProviderFixtureResult["tournamentPlayerStats"]>[number] | undefined
): string {
  if (!stat || market.template?.category !== "PLAYER_FUTURE") return "missing";
  switch (market.template.template) {
    case "TOURNAMENT_GOALS_OVER":
      return `${statValue(stat.goals)} goals vs line ${market.template.line}`;
    case "TOURNAMENT_ASSISTS_OVER":
      return `${statValue(stat.assists)} assists vs line ${market.template.line}`;
    case "TOURNAMENT_CARDS_OVER":
      return `${statValue(stat.cards ?? statValue(stat.yellowCards) + statValue(stat.redCards))} cards vs line ${market.template.line}`;
    case "TOURNAMENT_FOULS_OVER":
      return `${statValue(stat.foulsCommitted)} fouls committed vs line ${market.template.line}`;
    case "TOURNAMENT_FREE_KICK_GOAL":
      return `${statValue(stat.freeKickGoals)} free-kick goals`;
  }
}

function normalizePlayerName(playerName: string): string {
  return playerName.trim().toLowerCase().replace(/\s+/g, " ");
}

function scoringPlayerLabels(result: ProviderFixtureResult): string {
  const players = result.scoringPlayers?.map((player) => `${player.playerName}${player.playerId ? `#${player.playerId}` : ""}`);
  if (players && players.length > 0) return players.join(", ");
  return result.scoringPlayerNames?.join(", ") ?? "none";
}
