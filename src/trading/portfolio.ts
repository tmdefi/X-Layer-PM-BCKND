import type { Address } from "viem";
import type { InMemoryStore } from "../api/store.js";
import type { MarketDefinition, OutcomeDefinition, ResolutionDecision } from "../markets/types.js";
import type { StoredClobFill, StoredClobOrder, StoredClobTrade } from "./types.js";
import { marketSummaryData } from "./market-data.js";

export type PortfolioOutcomeBalance = {
  outcome: OutcomeDefinition;
  tokenId: string;
  balance: string;
  winning: boolean;
  redeemable: boolean;
  averagePrice?: string | undefined;
  costBasis?: string | undefined;
  currentPrice?: string | undefined;
  currentValue?: string | undefined;
  unrealizedPnl?: string | undefined;
  realizedPnl?: string | undefined;
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

  return [...touchedIds].map((id) => store.getMarket(id)).filter(isMarket);
}

export function enrichPortfolioPosition(input: {
  store?: InMemoryStore | undefined;
  account?: Address | undefined;
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
  const outcomePrices = input.store
    ? marketSummaryData(input.store, input.market.id, input.market.outcomes.map((outcome) => outcome.side)).prices
    : {};
  const costBasis = input.store && input.account
    ? outcomeCostBasis(input.store, input.account, input.market.id)
    : new Map<string, OutcomeCostBasis>();
  const outcomes = input.market.outcomes.map((outcome, index) => {
    const winning = outcome.side === input.resolution?.outcome;
    const balance = balances[index] ?? "0";
    const basis = costBasis.get(outcome.side);
    const averagePrice = basis ? priceFromAmounts(basis.cost, basis.shares) : undefined;
    const currentPrice = markPrice(outcomePrices[outcome.side], input.resolution, winning);
    const valuation = valuePosition(balance, averagePrice, currentPrice);

    return {
      outcome,
      tokenId: tokenIds[index] ?? "0",
      balance,
      winning,
      redeemable: resolutionSubmitted && winning && BigInt(balance) > 0n,
      ...(averagePrice ? { averagePrice } : {}),
      ...(valuation.costBasis ? { costBasis: valuation.costBasis } : {}),
      ...(currentPrice ? { currentPrice } : {}),
      ...(valuation.currentValue ? { currentValue: valuation.currentValue } : {}),
      ...(valuation.unrealizedPnl ? { unrealizedPnl: valuation.unrealizedPnl } : {})
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

type OutcomeCostBasis = {
  shares: bigint;
  cost: bigint;
};

function outcomeCostBasis(store: InMemoryStore, account: Address, marketId: string): Map<string, OutcomeCostBasis> {
  const accountOrders = store
    .listClobOrders(marketId)
    .filter((order) => order.order.maker.toLowerCase() === account.toLowerCase());
  const ordersById = new Map(accountOrders.map((order) => [order.id, order]));
  const basis = new Map<string, OutcomeCostBasis>();

  for (const fill of store.listClobFills()) {
    const order = ordersById.get(fill.orderId);
    if (!order || order.side !== "BUY") continue;

    const current = basis.get(order.outcomeSide) ?? { shares: 0n, cost: 0n };
    current.cost += BigInt(fill.makerAmountFilled);
    current.shares += BigInt(fill.takerAmountFilled);
    basis.set(order.outcomeSide, current);
  }

  return basis;
}

function markPrice(
  price: {
    bestBid?: string | undefined;
    midpoint?: string | undefined;
    lastTradePrice?: string | undefined;
    bestAsk?: string | undefined;
  } | undefined,
  resolution: ResolutionDecision | undefined,
  winning: boolean
): string | undefined {
  if (resolution?.status === "submitted") return winning ? "1" : "0";
  return price?.bestBid ?? price?.midpoint ?? price?.lastTradePrice ?? price?.bestAsk;
}

function valuePosition(balance: string, averagePrice: string | undefined, currentPrice: string | undefined) {
  if (!averagePrice || !currentPrice) return {};

  const balanceAmount = BigInt(balance);
  const costBasis = amountAtPrice(balanceAmount, averagePrice);
  const currentValue = amountAtPrice(balanceAmount, currentPrice);

  return {
    costBasis: costBasis.toString(),
    currentValue: currentValue.toString(),
    unrealizedPnl: (currentValue - costBasis).toString()
  };
}

function priceFromAmounts(cost: bigint, shares: bigint): string | undefined {
  if (shares <= 0n) return undefined;
  return decimalRatio(cost, shares);
}

function amountAtPrice(amount: bigint, price: string): bigint {
  return (amount * decimalToMicro(price)) / 1_000_000n;
}

function decimalRatio(numerator: bigint, denominator: bigint): string {
  return microToDecimal((numerator * 1_000_000n) / denominator);
}

function decimalToMicro(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6) || "0");
}

function microToDecimal(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function isMarket(market: MarketDefinition | undefined): market is MarketDefinition {
  return Boolean(market);
}
