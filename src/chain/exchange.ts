import {
  encodeFunctionData,
  maxUint256,
  type Address,
  type Hex,
  zeroHash,
  zeroAddress
} from "viem";
import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import type { OutcomeSide } from "../markets/types.js";
import type { MarketDefinition } from "../markets/types.js";
import type { ClobOrderSide, ExchangeOrder, StoredClobOrder } from "../trading/types.js";
import { ctfExchangeAbi, erc1155ConditionalTokensAbi, erc20CollateralAbi } from "./abis.js";
import { createChainClients, createPublicChainClient, requireAddress } from "./client.js";
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
  if (!market) {
    throw Object.assign(
      new Error(`Market ${input.marketId} has not been recreated under the current USDC market factory`),
      { statusCode: 409 }
    );
  }

  const publicClient = createPublicChainClient();
  await assertMarketUsesCurrentCollateral(publicClient, market);
  const nonce = await publicClient.readContract({
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

export type ExchangeOrderReadinessInput = {
  marketId: string;
  outcomeSide: OutcomeSide;
  maker: Address;
  side: ClobOrderSide;
  makerAmount: string;
};

export type AccountMarketOutcomeBalances = {
  marketId: string;
  conditionId: Hex;
  token0: string;
  token1: string;
  balance0: string;
  balance1: string;
};

export type AccountPortfolioBalances = {
  account: Address;
  collateral: {
    address: Address;
    balance: string;
  };
  markets: AccountMarketOutcomeBalances[];
};

export type ExchangeOrderReadiness = {
  ready: boolean;
  marketId: string;
  outcomeSide: OutcomeSide;
  side: ClobOrderSide;
  maker: Address;
  tokenId: string;
  exchange: Address;
  asset: {
    kind: "COLLATERAL" | "CONDITIONAL_TOKEN";
    address: Address;
    requiredAmount: string;
    balance: string;
    hasBalance: boolean;
  };
  approval: {
    approved: boolean;
    allowance?: string | undefined;
    transaction?: { to: Address; data: Hex } | undefined;
  };
};

export async function getExchangeOrderReadiness(input: ExchangeOrderReadinessInput): Promise<ExchangeOrderReadiness> {
  const market = await getMarketOnChain(input.marketId);
  if (!market) {
    throw Object.assign(
      new Error(`Market ${input.marketId} has not been recreated under the current USDC market factory`),
      { statusCode: 409 }
    );
  }

  const publicClient = createPublicChainClient();
  const exchange = exchangeAddress();
  const collateral = requireAddress(env.COLLATERAL_TOKEN_ADDRESS, "COLLATERAL_TOKEN_ADDRESS");
  const conditionalTokens = requireAddress(env.CONDITIONAL_TOKENS_ADDRESS, "CONDITIONAL_TOKENS_ADDRESS");
  await assertMarketUsesCurrentCollateral(publicClient, market, collateral, conditionalTokens);
  const tokenId = input.outcomeSide === "NO" || input.outcomeSide === "UNDER" ? market.token0 : market.token1;
  const requiredAmount = BigInt(input.makerAmount);

  if (input.side === "BUY") {
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({
        address: collateral,
        abi: erc20CollateralAbi,
        functionName: "balanceOf",
        args: [input.maker]
      }),
      publicClient.readContract({
        address: collateral,
        abi: erc20CollateralAbi,
        functionName: "allowance",
        args: [input.maker, exchange]
      })
    ]);
    const hasBalance = balance >= requiredAmount;
    const approved = allowance >= requiredAmount;

    return buildBuyOrderReadiness({
      marketId: input.marketId,
      outcomeSide: input.outcomeSide,
      maker: input.maker,
      tokenId,
      exchange,
      collateral,
      requiredAmount: input.makerAmount,
      balance: balance.toString(),
      allowance: allowance.toString()
    });
  }

  const [balance, approved] = await Promise.all([
    publicClient.readContract({
      address: conditionalTokens,
      abi: erc1155ConditionalTokensAbi,
      functionName: "balanceOf",
      args: [input.maker, BigInt(tokenId)]
    }),
    publicClient.readContract({
      address: conditionalTokens,
      abi: erc1155ConditionalTokensAbi,
      functionName: "isApprovedForAll",
      args: [input.maker, exchange]
    })
  ]);
  const hasBalance = balance >= requiredAmount;

  return buildSellOrderReadiness({
    marketId: input.marketId,
    outcomeSide: input.outcomeSide,
    maker: input.maker,
    tokenId,
    exchange,
    conditionalTokens,
    requiredAmount: input.makerAmount,
    balance: balance.toString(),
    approved
  });
}

export async function getAccountPortfolioBalances(
  account: Address,
  markets: MarketDefinition[]
): Promise<AccountPortfolioBalances> {
  const publicClient = createPublicChainClient();
  const collateral = requireAddress(env.COLLATERAL_TOKEN_ADDRESS, "COLLATERAL_TOKEN_ADDRESS");
  const conditionalTokens = requireAddress(env.CONDITIONAL_TOKENS_ADDRESS, "CONDITIONAL_TOKENS_ADDRESS");
  const collateralBalance = await publicClient.readContract({
    address: collateral,
    abi: erc20CollateralAbi,
    functionName: "balanceOf",
    args: [account]
  });
  const marketBalances = await Promise.all(
    markets.map(async (market) => {
      const stored = await getMarketOnChain(market.id);
      if (!stored) return undefined;
      const usesCurrentCollateral = await marketUsesCurrentCollateral(
        publicClient,
        conditionalTokens,
        collateral,
        stored
      );
      if (!usesCurrentCollateral) return undefined;

      const [balance0, balance1] = await Promise.all([
        publicClient.readContract({
          address: conditionalTokens,
          abi: erc1155ConditionalTokensAbi,
          functionName: "balanceOf",
          args: [account, BigInt(stored.token0)]
        }),
        publicClient.readContract({
          address: conditionalTokens,
          abi: erc1155ConditionalTokensAbi,
          functionName: "balanceOf",
          args: [account, BigInt(stored.token1)]
        })
      ]);

      return {
        marketId: market.id,
        conditionId: stored.conditionId,
        token0: stored.token0,
        token1: stored.token1,
        balance0: balance0.toString(),
        balance1: balance1.toString()
      };
    })
  );

  return {
    account,
    collateral: {
      address: collateral,
      balance: collateralBalance.toString()
    },
    markets: marketBalances.filter(isAccountMarketOutcomeBalances)
  };
}

export async function redemptionTransaction(marketId: string) {
  const stored = await getMarketOnChain(marketId);
  if (!stored) throw new Error(`Market ${marketId} has not been created on-chain`);

  const conditionalTokens = requireAddress(env.CONDITIONAL_TOKENS_ADDRESS, "CONDITIONAL_TOKENS_ADDRESS");
  const collateral = requireAddress(env.COLLATERAL_TOKEN_ADDRESS, "COLLATERAL_TOKEN_ADDRESS");
  const publicClient = createPublicChainClient();
  const usesCurrentCollateral = await marketUsesCurrentCollateral(
    publicClient,
    conditionalTokens,
    collateral,
    stored
  );
  if (!usesCurrentCollateral) {
    throw Object.assign(
      new Error("Market positions were not created with the configured USDC collateral token"),
      { statusCode: 409 }
    );
  }

  return {
    to: conditionalTokens,
    data: encodeFunctionData({
      abi: erc1155ConditionalTokensAbi,
      functionName: "redeemPositions",
      args: [collateral, zeroHash, stored.conditionId, [1n, 2n]]
    })
  };
}

export async function marketUsesCurrentCollateral(
  publicClient: ReturnType<typeof createPublicChainClient>,
  conditionalTokens: Address,
  collateral: Address,
  stored: {
    conditionId: Hex;
    token0: string;
    token1: string;
  }
) {
  const [collection0, collection1] = await Promise.all([
    publicClient.readContract({
      address: conditionalTokens,
      abi: erc1155ConditionalTokensAbi,
      functionName: "getCollectionId",
      args: [zeroHash, stored.conditionId, 1n]
    }),
    publicClient.readContract({
      address: conditionalTokens,
      abi: erc1155ConditionalTokensAbi,
      functionName: "getCollectionId",
      args: [zeroHash, stored.conditionId, 2n]
    })
  ]);
  const [position0, position1] = await Promise.all([
    publicClient.readContract({
      address: conditionalTokens,
      abi: erc1155ConditionalTokensAbi,
      functionName: "getPositionId",
      args: [collateral, collection0]
    }),
    publicClient.readContract({
      address: conditionalTokens,
      abi: erc1155ConditionalTokensAbi,
      functionName: "getPositionId",
      args: [collateral, collection1]
    })
  ]);

  return position0.toString() === stored.token0 && position1.toString() === stored.token1;
}

async function assertMarketUsesCurrentCollateral(
  publicClient: ReturnType<typeof createPublicChainClient>,
  stored: {
    conditionId: Hex;
    token0: string;
    token1: string;
  },
  collateral = requireAddress(env.COLLATERAL_TOKEN_ADDRESS, "COLLATERAL_TOKEN_ADDRESS"),
  conditionalTokens = requireAddress(env.CONDITIONAL_TOKENS_ADDRESS, "CONDITIONAL_TOKENS_ADDRESS")
) {
  const usesCurrentCollateral = await marketUsesCurrentCollateral(
    publicClient,
    conditionalTokens,
    collateral,
    stored
  );
  if (!usesCurrentCollateral) {
    throw Object.assign(
      new Error("Market was created with a different USDC collateral token and must be recreated"),
      { statusCode: 409 }
    );
  }
}

export function buildBuyOrderReadiness(input: {
  marketId: string;
  outcomeSide: OutcomeSide;
  maker: Address;
  tokenId: string;
  exchange: Address;
  collateral: Address;
  requiredAmount: string;
  balance: string;
  allowance: string;
}): ExchangeOrderReadiness {
  const hasBalance = BigInt(input.balance) >= BigInt(input.requiredAmount);
  const approved = BigInt(input.allowance) >= BigInt(input.requiredAmount);

  return {
    ready: hasBalance && approved,
    marketId: input.marketId,
    outcomeSide: input.outcomeSide,
    side: "BUY",
    maker: input.maker,
    tokenId: input.tokenId,
    exchange: input.exchange,
    asset: {
      kind: "COLLATERAL",
      address: input.collateral,
      requiredAmount: input.requiredAmount,
      balance: input.balance,
      hasBalance
    },
    approval: {
      approved,
      allowance: input.allowance,
      ...(!approved ? { transaction: collateralApprovalTransaction(input.collateral, input.exchange) } : {})
    }
  };
}

export function buildSellOrderReadiness(input: {
  marketId: string;
  outcomeSide: OutcomeSide;
  maker: Address;
  tokenId: string;
  exchange: Address;
  conditionalTokens: Address;
  requiredAmount: string;
  balance: string;
  approved: boolean;
}): ExchangeOrderReadiness {
  const hasBalance = BigInt(input.balance) >= BigInt(input.requiredAmount);

  return {
    ready: hasBalance && input.approved,
    marketId: input.marketId,
    outcomeSide: input.outcomeSide,
    side: "SELL",
    maker: input.maker,
    tokenId: input.tokenId,
    exchange: input.exchange,
    asset: {
      kind: "CONDITIONAL_TOKEN",
      address: input.conditionalTokens,
      requiredAmount: input.requiredAmount,
      balance: input.balance,
      hasBalance
    },
    approval: {
      approved: input.approved,
      ...(!input.approved ? { transaction: conditionalTokensApprovalTransaction(input.conditionalTokens, input.exchange) } : {})
    }
  };
}

export async function validateExchangeOrder(order: ExchangeOrder): Promise<Hex> {
  const clients = createChainClients();
  const exchange = exchangeAddress();
  const contractOrder = toContractOrder(order);

  const orderHash = await clients.publicClient.readContract({
    address: exchange,
    abi: ctfExchangeAbi,
    functionName: "hashOrder",
    args: [contractOrder]
  });

  try {
    await clients.publicClient.readContract({
      address: exchange,
      abi: ctfExchangeAbi,
      functionName: "validateOrder",
      args: [contractOrder]
    });
  } catch {
    throw Object.assign(new Error("Order failed on-chain validation"), { statusCode: 400 });
  }

  return orderHash;
}

export async function getExchangeNonce(maker: Address): Promise<string> {
  const publicClient = createPublicChainClient();
  const nonce = await publicClient.readContract({
    address: exchangeAddress(),
    abi: ctfExchangeAbi,
    functionName: "nonces",
    args: [maker]
  });
  return nonce.toString();
}

export async function getExchangeOrderStatus(orderHash: Hex) {
  const publicClient = createPublicChainClient();
  const [status] = await Promise.all([
    publicClient.readContract({
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

function collateralApprovalTransaction(collateral: Address, exchange: Address) {
  return {
    to: collateral,
    data: encodeFunctionData({
      abi: erc20CollateralAbi,
      functionName: "approve",
      args: [exchange, maxUint256]
    })
  };
}

function conditionalTokensApprovalTransaction(conditionalTokens: Address, exchange: Address) {
  return {
    to: conditionalTokens,
    data: encodeFunctionData({
      abi: erc1155ConditionalTokensAbi,
      functionName: "setApprovalForAll",
      args: [exchange, true]
    })
  };
}

export async function matchExchangeOrders(input: {
  takerOrder: StoredClobOrder;
  makerOrders: StoredClobOrder[];
  takerFillAmount: string;
  makerFillAmounts: string[];
  onSubmitted?: ((hash: Hex) => void) | undefined;
}): Promise<Hex> {
  const clients = createChainClients();
  const exchange = exchangeAddress();
  const args = [
    toContractOrder(input.takerOrder.order),
    input.makerOrders.map((order) => toContractOrder(order.order)),
    BigInt(input.takerFillAmount),
    input.makerFillAmounts.map(BigInt)
  ] as const;

  const hash = await writeMatchOrdersWithNonceRetry(clients, exchange, args);
  input.onSubmitted?.(hash);
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Order match transaction failed: ${hash}`);
  return hash;
}

async function writeMatchOrdersWithNonceRetry(
  clients: ReturnType<typeof createChainClients>,
  exchange: Address,
  args: readonly [
    ReturnType<typeof toContractOrder>,
    ReturnType<typeof toContractOrder>[],
    bigint,
    bigint[]
  ]
): Promise<Hex> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const nonce = attempt === 0
        ? undefined
        : await clients.publicClient.getTransactionCount({
          address: clients.account.address,
          blockTag: "pending"
        });
      return await clients.walletClient.writeContract({
        address: exchange,
        abi: ctfExchangeAbi,
        functionName: "matchOrders",
        args,
        account: clients.account,
        ...(nonce === undefined ? {} : { nonce })
      });
    } catch (error) {
      lastError = error;
      if (!isNonceTooLowError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  throw lastError;
}

function isNonceTooLowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /nonce (provided .* lower|too low|has already been used)/i.test(message);
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

function isAccountMarketOutcomeBalances(
  market: AccountMarketOutcomeBalances | undefined
): market is AccountMarketOutcomeBalances {
  return Boolean(market);
}
