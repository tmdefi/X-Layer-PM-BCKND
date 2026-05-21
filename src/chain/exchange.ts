import {
  encodeFunctionData,
  type Address,
  type Hex,
  zeroAddress
} from "viem";
import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import type { OutcomeSide } from "../markets/types.js";
import type { ClobOrderSide, ExchangeOrder, StoredClobOrder } from "../trading/types.js";
import { ctfExchangeAbi } from "./abis.js";
import { createChainClients, requireAddress } from "./client.js";
import { getMarketOnChain } from "./markets.js";

export const exchangeDomain = {
  name: "Polymarket CTF Exchange",
  version: "1"
} as const;

export const exchangeOrderTypedData = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" }
  ]
} as const;

export async function prepareExchangeOrder(input: {
  marketId: string;
  outcomeSide: OutcomeSide;
  maker: Address;
  signer?: Address | undefined;
  taker?: Address | undefined;
  side: ClobOrderSide;
  makerAmount: string;
  takerAmount: string;
  expiration?: string | undefined;
  feeRateBps?: string | undefined;
  signatureType?: 0 | 1 | undefined;
}) {
  const exchange = exchangeAddress();
  const market = await getMarketOnChain(input.marketId);
  if (!market) throw new Error(`Market ${input.marketId} has not been created on-chain`);

  const clients = createChainClients();
  const nonce = await clients.publicClient.readContract({
    address: exchange,
    abi: ctfExchangeAbi,
    functionName: "nonces",
    args: [input.maker]
  });
  const tokenId = input.outcomeSide === "NO" || input.outcomeSide === "UNDER" ? market.token0 : market.token1;
  const side = input.side === "BUY" ? 0 : 1;
  const signatureType = input.signatureType ?? 0;
  const order: ExchangeOrder = {
    salt: randomSalt(),
    maker: input.maker,
    signer: input.signer ?? input.maker,
    taker: input.taker ?? zeroAddress,
    tokenId,
    makerAmount: input.makerAmount,
    takerAmount: input.takerAmount,
    expiration: input.expiration ?? "0",
    nonce: nonce.toString(),
    feeRateBps: input.feeRateBps ?? "0",
    side,
    signatureType,
    signature: "0x"
  };

  return {
    market,
    order,
    typedData: {
      domain: {
        ...exchangeDomain,
        chainId: env.XLAYER_CHAIN_ID,
        verifyingContract: exchange
      },
      types: exchangeOrderTypedData,
      primaryType: "Order",
      message: orderMessage(order)
    }
  };
}

export async function validateExchangeOrder(order: ExchangeOrder): Promise<Hex> {
  const clients = createChainClients();
  const exchange = exchangeAddress();
  const contractOrder = toContractOrder(order);

  await clients.publicClient.readContract({
    address: exchange,
    abi: ctfExchangeAbi,
    functionName: "validateOrder",
    args: [contractOrder]
  });

  return clients.publicClient.readContract({
    address: exchange,
    abi: ctfExchangeAbi,
    functionName: "hashOrder",
    args: [contractOrder]
  });
}

export async function getExchangeNonce(maker: Address): Promise<string> {
  const clients = createChainClients();
  const nonce = await clients.publicClient.readContract({
    address: exchangeAddress(),
    abi: ctfExchangeAbi,
    functionName: "nonces",
    args: [maker]
  });
  return nonce.toString();
}

export async function getExchangeOrderStatus(orderHash: Hex) {
  const clients = createChainClients();
  const [status] = await Promise.all([
    clients.publicClient.readContract({
      address: exchangeAddress(),
      abi: ctfExchangeAbi,
      functionName: "getOrderStatus",
      args: [orderHash]
    })
  ]);

  return {
    isFilledOrCancelled: status.isFilledOrCancelled,
    remaining: status.remaining.toString()
  };
}

export function cancellationTransaction(order: ExchangeOrder) {
  return {
    to: exchangeAddress(),
    data: encodeFunctionData({
      abi: ctfExchangeAbi,
      functionName: "cancelOrder",
      args: [toContractOrder(order)]
    })
  };
}

export function incrementNonceTransaction() {
  return {
    to: exchangeAddress(),
    data: encodeFunctionData({
      abi: ctfExchangeAbi,
      functionName: "incrementNonce"
    })
  };
}

export async function matchExchangeOrders(input: {
  takerOrder: StoredClobOrder;
  makerOrders: StoredClobOrder[];
  takerFillAmount: string;
  makerFillAmounts: string[];
}): Promise<Hex> {
  const clients = createChainClients();
  const exchange = exchangeAddress();
  const hash = await clients.walletClient.writeContract({
    address: exchange,
    abi: ctfExchangeAbi,
    functionName: "matchOrders",
    args: [
      toContractOrder(input.takerOrder.order),
      input.makerOrders.map((order) => toContractOrder(order.order)),
      BigInt(input.takerFillAmount),
      input.makerFillAmounts.map(BigInt)
    ],
    account: clients.account
  });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Order match transaction failed: ${hash}`);
  return hash;
}

export function exchangeAddress(): Address {
  return requireAddress(env.CTF_EXCHANGE_ADDRESS, "CTF_EXCHANGE_ADDRESS");
}

export function toContractOrder(order: ExchangeOrder) {
  return {
    salt: BigInt(order.salt),
    maker: order.maker as Address,
    signer: order.signer as Address,
    taker: order.taker as Address,
    tokenId: BigInt(order.tokenId),
    makerAmount: BigInt(order.makerAmount),
    takerAmount: BigInt(order.takerAmount),
    expiration: BigInt(order.expiration),
    nonce: BigInt(order.nonce),
    feeRateBps: BigInt(order.feeRateBps),
    side: order.side,
    signatureType: order.signatureType,
    signature: order.signature
  };
}

function orderMessage(order: ExchangeOrder) {
  return {
    salt: order.salt,
    maker: order.maker,
    signer: order.signer,
    taker: order.taker,
    tokenId: order.tokenId,
    makerAmount: order.makerAmount,
    takerAmount: order.takerAmount,
    expiration: order.expiration,
    nonce: order.nonce,
    feeRateBps: order.feeRateBps,
    side: order.side,
    signatureType: order.signatureType
  };
}

function randomSalt(): string {
  return BigInt(`0x${randomBytes(32).toString("hex")}`).toString();
}
