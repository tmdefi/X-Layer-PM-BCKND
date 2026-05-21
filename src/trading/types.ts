import type { Hex } from "viem";
import type { OutcomeSide } from "../markets/types.js";

export type ClobOrderSide = "BUY" | "SELL";
export type ClobOrderStatus = "open" | "partially_filled" | "filled" | "cancelled";

export type ExchangeOrder = {
  salt: string;
  maker: Hex;
  signer: Hex;
  taker: Hex;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: 0 | 1;
  signatureType: 0 | 1;
  signature: Hex;
};

export type StoredClobOrder = {
  id: string;
  orderHash: Hex;
  marketId: string;
  outcomeSide: OutcomeSide;
  order: ExchangeOrder;
  side: ClobOrderSide;
  remainingMaker: string;
  status: ClobOrderStatus;
  createdAt: string;
  updatedAt: string;
};

export type StoredClobFill = {
  id: string;
  orderId: string;
  tradeId: string;
  makerAmountFilled: string;
  takerAmountFilled: string;
  transactionHash: Hex;
  createdAt: string;
};

export type StoredClobTrade = {
  id: string;
  marketId: string;
  takerOrderId: string;
  makerOrderIds: string[];
  transactionHash: Hex;
  takerFillAmount: string;
  makerFillAmounts: string[];
  createdAt: string;
};
