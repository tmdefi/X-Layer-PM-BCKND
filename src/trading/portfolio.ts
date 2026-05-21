import type { Address } from "viem";
import type { InMemoryStore } from "../api/store.js";
import type { MarketDefinition, OutcomeDefinition, ResolutionDecision } from "../markets/types.js";
import type { StoredClobFill, StoredClobOrder, StoredClobTrade } from "./types.js";

export type PortfolioOutcomeBalance = {
  outcome: OutcomeDefinition;
  tokenId: string;
  balance: string;
  winning: boolean;
  redeemable: boolean;
};

export type PortfolioPosition = {
  market: MarketDefinition;
  conditionId?: string | undefined;
  resolution?: ResolutionDecision | undefined;
  outcomes: PortfolioOutcomeBalance[];
  hasBalance: boolean;
};

export type PortfolioActivity = {
  orders: {
    open: StoredClobOrder[];
    history: StoredClobOrder[];
  };
  trades: StoredClobTrade[];
  fills: StoredClobFill[];
};

export function portfolioActivity(store: InMemoryStore, account: Address): PortfolioActivity {
  const orders = store
    .listClobOrders()
    .filter((order) => order.order.maker.toLowerCase() === account.toLowerCase());
  const orderIds = new Set(orders.map((order) => order.id));
  const fills = store.listClobFills().filter((fill) => orderIds.has(fill.orderId));
  const fillTradeIds = new Set(fills.map((fill) => fill.tradeId));
  const trades = store.listClobTrades().filter((trade) => fillTradeIds.has(trade.id));

  return {
    orders: {
      open: orders.filter((order) => order.status === "open" || order.status === "partially_filled"),
      history: orders.filter((order) => order.status === "filled" || order.status === "cancelled")
    },
    trades,
    fills
  };
}

export function portfolioMarketCandidates(
  store: InMemoryStore,
  account: Address,
  marketIds?: string[] | undefined
): MarketDefinition[] {
  if (marketIds?.length) {
    return marketIds.map((id) => store.getMarket(id)).filter(isMarket);
  }

  const touchedIds = new Set(
    store
      .listClobOrders()
      .filter((order) => order.order.maker.toLowerCase() === account.toLowerCase())
      .map((order) => order.marketId)
  );

  return store
    .listMarkets()
    .filter((market) => Boolean(market.conditionId) || touchedIds.has(market.id));
}

export function enrichPortfolioPosition(input: {
  market: MarketDefinition;
  token0: string;
  token1: string;
  balance0: string;
  balance1: string;
  resolution?: ResolutionDecision | undefined;
}): PortfolioPosition {
  const tokenIds = [input.token0, input.token1] as const;
  const balances = [input.balance0, input.balance1] as const;
  const resolutionSubmitted = input.resolution?.status === "submitted";
  const outcomes = input.market.outcomes.map((outcome, index) => {
    const winning = outcome.side === input.resolution?.outcome;
    const balance = balances[index] ?? "0";

    return {
      outcome,
      tokenId: tokenIds[index] ?? "0",
      balance,
      winning,
      redeemable: resolutionSubmitted && winning && BigInt(balance) > 0n
    };
  }) as PortfolioOutcomeBalance[];

  return {
    market: input.market,
    ...(input.market.conditionId ? { conditionId: input.market.conditionId } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    outcomes,
    hasBalance: outcomes.some((outcome) => BigInt(outcome.balance) > 0n)
  };
}

function isMarket(market: MarketDefinition | undefined): market is MarketDefinition {
  return Boolean(market);
}
