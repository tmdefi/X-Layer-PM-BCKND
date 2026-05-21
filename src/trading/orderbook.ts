import type { OutcomeSide } from "../markets/types.js";
import type { StoredClobOrder } from "./types.js";

export function buildOrderbook(orders: StoredClobOrder[]) {
  const open = orders.filter((order) => order.status === "open" || order.status === "partially_filled");
  const outcomes = [...new Set(open.map((order) => order.outcomeSide))] as OutcomeSide[];

  return Object.fromEntries(
    outcomes.map((outcome) => {
      const outcomeOrders = open.filter((order) => order.outcomeSide === outcome);
      return [
        outcome,
        {
          bids: levels(outcomeOrders.filter((order) => order.side === "BUY"), true),
          asks: levels(outcomeOrders.filter((order) => order.side === "SELL"), false),
          bestBid: priceFor(outcomeOrders.filter((order) => order.side === "BUY").sort(sortBid)[0]),
          bestAsk: priceFor(outcomeOrders.filter((order) => order.side === "SELL").sort(sortAsk)[0])
        }
      ];
    })
  );
}

export function orderPrice(order: StoredClobOrder): string {
  const makerAmount = BigInt(order.order.makerAmount);
  const takerAmount = BigInt(order.order.takerAmount);
  if (makerAmount === 0n || takerAmount === 0n) return "0";

  const collateral = order.side === "BUY" ? makerAmount : takerAmount;
  const shares = order.side === "BUY" ? takerAmount : makerAmount;
  return ratio(collateral, shares);
}

export function proportionalTakingAmount(order: StoredClobOrder, makingAmount: string): string {
  return ((BigInt(makingAmount) * BigInt(order.order.takerAmount)) / BigInt(order.order.makerAmount)).toString();
}

function levels(orders: StoredClobOrder[], bids: boolean) {
  const byPrice = new Map<string, bigint>();
  for (const order of orders) {
    const price = orderPrice(order);
    const remaining = BigInt(order.remainingMaker);
    const shareSize =
      order.side === "BUY"
        ? (remaining * BigInt(order.order.takerAmount)) / BigInt(order.order.makerAmount)
        : remaining;
    byPrice.set(price, (byPrice.get(price) ?? 0n) + shareSize);
  }

  return [...byPrice.entries()]
    .map(([price, size]) => ({ price, size: size.toString() }))
    .sort((a, b) => (bids ? compareDecimal(b.price, a.price) : compareDecimal(a.price, b.price)));
}

function sortBid(a: StoredClobOrder, b: StoredClobOrder): number {
  return compareDecimal(orderPrice(b), orderPrice(a));
}

function sortAsk(a: StoredClobOrder, b: StoredClobOrder): number {
  return compareDecimal(orderPrice(a), orderPrice(b));
}

function priceFor(order: StoredClobOrder | undefined): string | undefined {
  return order ? orderPrice(order) : undefined;
}

function ratio(numerator: bigint, denominator: bigint): string {
  const scale = 1_000_000n;
  const scaled = (numerator * scale) / denominator;
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function compareDecimal(a: string, b: string): number {
  const [aWhole = "0", aFraction = ""] = a.split(".");
  const [bWhole = "0", bFraction = ""] = b.split(".");
  const fractionLength = Math.max(aFraction.length, bFraction.length);
  const left = BigInt(`${aWhole}${aFraction.padEnd(fractionLength, "0")}`);
  const right = BigInt(`${bWhole}${bFraction.padEnd(fractionLength, "0")}`);
  return left < right ? -1 : left > right ? 1 : 0;
}
