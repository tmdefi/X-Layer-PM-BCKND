import "dotenv/config";
import { createStore } from "../src/api/store.js";
import {
  PLAYER_TOURNAMENT_FUTURE_OVER_LINES,
  PLAYER_TOURNAMENT_FUTURE_TEMPLATES
} from "../src/markets/definitions.js";
import type { MarketDefinition, MarketTemplateRef } from "../src/markets/types.js";

const write = process.env.PLAYER_FUTURE_LINE_WRITE === "true";
const statuses = new Set((process.env.PLAYER_FUTURE_LINE_STATUSES ?? "draft,open")
  .split(",")
  .map((status) => status.trim())
  .filter(Boolean));
const allowedLines = [...PLAYER_TOURNAMENT_FUTURE_OVER_LINES];
const store = await createStore();

const candidates = store.listMarkets()
  .filter((market) => statuses.has(market.status))
  .filter((market) => market.template?.category === "PLAYER_FUTURE")
  .filter((market) => playerFutureTemplate(market.template)?.requiresLine);

const changed: Array<{
  marketId: string;
  playerName: string;
  template: string;
  previousLine: string | undefined;
  nextLine: string;
  previousTitle: string;
  nextTitle: string;
}> = [];

for (const market of candidates) {
  const template = market.template;
  if (template?.category !== "PLAYER_FUTURE") continue;

  const nextLine = normalizeLine(template.line);
  if (!nextLine || template.line === nextLine) continue;

  const marketTemplate = playerFutureTemplate(template);
  if (!marketTemplate) continue;

  const updatedMarket: MarketDefinition = {
    ...market,
    title: marketTemplate.title(template.player.playerName, nextLine),
    template: {
      ...template,
      line: nextLine
    }
  };

  changed.push({
    marketId: market.id,
    playerName: template.player.playerName,
    template: template.template,
    previousLine: template.line,
    nextLine,
    previousTitle: market.title,
    nextTitle: updatedMarket.title
  });

  if (write) {
    store.updateMarket(updatedMarket);
  }
}

if (write) {
  await store.waitForPendingWrites();
}

console.log(JSON.stringify({
  dryRun: !write,
  scanned: candidates.length,
  changed: changed.length,
  allowedLines,
  changedSample: changed.slice(0, 25)
}, null, 2));

function normalizeLine(line: string | undefined): string | undefined {
  const numericLine = Number(line);
  if (!Number.isFinite(numericLine)) return allowedLines[0];

  let nearest = allowedLines[0]!;
  let nearestDistance = Math.abs(Number(nearest) - numericLine);
  for (const candidate of allowedLines.slice(1)) {
    const distance = Math.abs(Number(candidate) - numericLine);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function playerFutureTemplate(template: MarketTemplateRef | undefined) {
  if (template?.category !== "PLAYER_FUTURE") return undefined;
  return PLAYER_TOURNAMENT_FUTURE_TEMPLATES.find((candidate) => candidate.template === template.template);
}
