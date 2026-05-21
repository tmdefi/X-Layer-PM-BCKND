import type { OutcomeSide } from "../markets/types.js";
import type { InMemoryStore } from "../api/store.js";
import { buildOrderbook, orderPrice, proportionalTakingAmount } from "./orderbook.js";
import type { StoredClobOrder, StoredClobTrade } from "./types.js";

export type MarketDataInterval = "1m" | "5m" | "15m" | "1h" | "1d";

export type MarketTradeTick = {
  id: string;
  marketId: string;
  outcomeSide: OutcomeSide;
  side: StoredClobOrder["side"];
  price: string;
  shareAmount: string;
  collateralAmount: string;
  transactionHash: StoredClobTrade["transactionHash"];
  createdAt: string;
};

type OutcomeOrderbook = {
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  bestBid?: string | undefined;
  bestAsk?: string | undefined;
};

export function marketTradeTicks(store: InMemoryStore, marketId: string): MarketTradeTick[] {
  return store.listClobTrades(marketId).flatMap((trade) => {
    const takerOrder = store.getClobOrder(trade.takerOrderId);
    if (!takerOrder) return [];

    return [{
      id: trade.id,
      marketId: trade.marketId,
      outcomeSide: takerOrder.outcomeSide,
      side: takerOrder.side,
      price: orderPrice(takerOrder),
      shareAmount: takerOrder.side === "BUY"
        ? proportionalTakingAmount(takerOrder, trade.takerFillAmount)
        : trade.takerFillAmount,
      collateralAmount: takerOrder.side === "BUY"
        ? trade.takerFillAmount
        : proportionalTakingAmount(takerOrder, trade.takerFillAmount),
      transactionHash: trade.transactionHash,
      createdAt: trade.createdAt
    }];
  });
}

export function marketPriceData(store: InMemoryStore, marketId: string, outcomes: OutcomeSide[]) {
  const orders = store.listClobOrders(marketId);
  const orderbook = buildOrderbook(orders) as Record<string, OutcomeOrderbook | undefined>;
  const ticks = marketTradeTicks(store, marketId);

  return Object.fromEntries(outcomes.map((outcomeSide) => {
    const book = orderbook[outcomeSide];
    const outcomeTicks = ticks.filter((tick) => tick.outcomeSide === outcomeSide);
    const lastTrade = outcomeTicks[0];

    return [outcomeSide, {
      bestBid: book?.bestBid,
      bestAsk: book?.bestAsk,
      midpoint: midpoint(book?.bestBid, book?.bestAsk),
      spread: spread(book?.bestBid, book?.bestAsk),
      lastTradePrice: lastTrade?.price,
      lastTradeAt: lastTrade?.createdAt,
      openOrderCount: orders.filter((order) =>
        order.outcomeSide === outcomeSide && isOpenOrder(order)
      ).length,
      tradeCount: outcomeTicks.length,
      volume: sumAmounts(outcomeTicks.map((tick) => tick.collateralAmount)),
      shareVolume: sumAmounts(outcomeTicks.map((tick) => tick.shareAmount))
    }];
  }));
}

export function marketSummaryData(store: InMemoryStore, marketId: string, outcomes: OutcomeSide[]) {
  const orders = store.listClobOrders(marketId);
  const ticks = marketTradeTicks(store, marketId);
  const prices = marketPriceData(store, marketId, outcomes);
  const latestOrderAt = newestTimestamp(orders.map((order) => order.updatedAt));

  return {
    prices,
    openOrderCount: orders.filter(isOpenOrder).length,
    tradeCount: ticks.length,
    volume: sumAmounts(ticks.map((tick) => tick.collateralAmount)),
    shareVolume: sumAmounts(ticks.map((tick) => tick.shareAmount)),
    latestTradeAt: ticks[0]?.createdAt,
    latestActivityAt: newestTimestamp([ticks[0]?.createdAt, latestOrderAt])
  };
}

export function marketCandles(
  ticks: MarketTradeTick[],
  interval: MarketDataInterval,
  outcomes: OutcomeSide[]
) {
  const bucketMs = intervalMilliseconds(interval);

  return Object.fromEntries(outcomes.map((outcomeSide) => {
    const candles = new Map<number, MarketTradeTick[]>();
    for (const tick of ticks.filter((trade) => trade.outcomeSide === outcomeSide).reverse()) {
      const bucket = Math.floor(Date.parse(tick.createdAt) / bucketMs) * bucketMs;
      candles.set(bucket, [...(candles.get(bucket) ?? []), tick]);
    }

    return [outcomeSide, [...candles.entries()].map(([bucket, bucketTicks]) => ({
      bucketStart: new Date(bucket).toISOString(),
      open: bucketTicks[0]?.price,
      high: extrema(bucketTicks.map((tick) => tick.price), "high"),
      low: extrema(bucketTicks.map((tick) => tick.price), "low"),
      close: bucketTicks[bucketTicks.length - 1]?.price,
      volume: sumAmounts(bucketTicks.map((tick) => tick.collateralAmount)),
      shareVolume: sumAmounts(bucketTicks.map((tick) => tick.shareAmount)),
      tradeCount: bucketTicks.length
    }))];
  }));
}

function isOpenOrder(order: StoredClobOrder): boolean {
  return order.status === "open" || order.status === "partially_filled";
}

function intervalMilliseconds(interval: MarketDataInterval): number {
  switch (interval) {
    case "1m":
      return 60_000;
    case "5m":
      return 300_000;
    case "15m":
      return 900_000;
    case "1h":
      return 3_600_000;
    case "1d":
      return 86_400_000;
  }
}

function midpoint(bid?: string, ask?: string): string | undefined {
  if (!bid || !ask) return undefined;
  return fromScaled((toScaled(bid) + toScaled(ask)) / 2n);
}

function spread(bid?: string, ask?: string): string | undefined {
  if (!bid || !ask) return undefined;
  return fromScaled(toScaled(ask) - toScaled(bid));
}

function extrema(values: string[], direction: "high" | "low"): string | undefined {
  const scaled = values.map(toScaled);
  if (scaled.length === 0) return undefined;
  const chosen = scaled.reduce((best, value) =>
    direction === "high"
      ? value > best ? value : best
      : value < best ? value : best
  );
  return fromScaled(chosen);
}

function sumAmounts(amounts: string[]): string {
  return amounts.reduce((total, amount) => total + BigInt(amount), 0n).toString();
}

function newestTimestamp(values: (string | undefined)[]): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function toScaled(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6) || "0");
}

function fromScaled(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${fraction ? `${whole}.${fraction}` : whole.toString()}`;
}
