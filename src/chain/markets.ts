import { decodeEventLog, keccak256, stringToHex, type Address, type Hex, type TransactionReceipt } from "viem";
import { env } from "../config/env.js";
import { binaryMarketResolverAbi, marketFactoryAbi } from "./abis.js";
import { createChainClients, requireAddress } from "./client.js";

export type OnChainMarketCreationInput = {
  marketId: string;
  questionId?: Hex | undefined;
  marketType: string;
  metadataURI: string;
};

export type OnChainMarketCreationResult = {
  transactionHash: Hex;
  conditionId?: Hex | undefined;
  token0?: string | undefined;
  token1?: string | undefined;
  marketId: Hex;
  questionId: Hex;
};

export type OnChainStoredMarket = {
  conditionId: Hex;
  questionId: Hex;
  oracle: Address;
  token0: string;
  token1: string;
  created: boolean;
};

export type ResolverOutcome = "TOKEN0" | "TOKEN1";

export type OnChainResolutionResult = {
  transactionHash: Hex;
  conditionId?: Hex | undefined;
  questionId: Hex;
  outcome: ResolverOutcome;
};

export async function createMarketOnChain(
  input: OnChainMarketCreationInput
): Promise<OnChainMarketCreationResult> {
  const clients = createChainClients();
  const marketFactory = requireAddress(env.MARKET_FACTORY_ADDRESS, "MARKET_FACTORY_ADDRESS");
  const resolver = requireAddress(env.BINARY_MARKET_RESOLVER_ADDRESS, "BINARY_MARKET_RESOLVER_ADDRESS");
  const marketId = hashIdentifier(input.marketId);
  const questionId = input.questionId ?? hashIdentifier(input.marketId);

  const hash = await clients.walletClient.writeContract({
    address: marketFactory,
    abi: marketFactoryAbi,
    functionName: "createBinaryMarket",
    args: [marketId, resolver, questionId, input.marketType, input.metadataURI],
    account: clients.account
  });

  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Market creation transaction failed: ${hash}`);
  }

  const event = findMarketCreatedEvent(receipt, marketFactory);
  const stored = event ? undefined : await getMarketOnChain(input.marketId);

  return {
    transactionHash: hash,
    conditionId: event?.conditionId ?? stored?.conditionId,
    token0: event?.token0?.toString() ?? stored?.token0,
    token1: event?.token1?.toString() ?? stored?.token1,
    marketId,
    questionId
  };
}

export async function getMarketOnChain(marketId: string): Promise<OnChainStoredMarket | undefined> {
  const clients = createChainClients();
  const marketFactory = requireAddress(env.MARKET_FACTORY_ADDRESS, "MARKET_FACTORY_ADDRESS");
  const stored = await clients.publicClient.readContract({
    address: marketFactory,
    abi: marketFactoryAbi,
    functionName: "markets",
    args: [hashIdentifier(marketId)]
  });

  if (!stored[5]) return undefined;

  return {
    conditionId: stored[0],
    questionId: stored[1],
    oracle: stored[2],
    token0: stored[3].toString(),
    token1: stored[4].toString(),
    created: stored[5]
  };
}

export async function resolveMarketOnChain(
  questionId: Hex,
  outcome: ResolverOutcome
): Promise<OnChainResolutionResult> {
  const clients = createChainClients();
  const resolver = requireAddress(env.BINARY_MARKET_RESOLVER_ADDRESS, "BINARY_MARKET_RESOLVER_ADDRESS");
  const outcomeIndex = outcome === "TOKEN0" ? 0 : 1;

  const hash = await clients.walletClient.writeContract({
    address: resolver,
    abi: binaryMarketResolverAbi,
    functionName: "resolve",
    args: [questionId, outcomeIndex],
    account: clients.account
  });

  const [receipt, conditionId] = await Promise.all([
    clients.publicClient.waitForTransactionReceipt({ hash }),
    clients.publicClient.readContract({
      address: resolver,
      abi: binaryMarketResolverAbi,
      functionName: "getConditionId",
      args: [questionId]
    })
  ]);

  if (receipt.status !== "success") {
    throw new Error(`Resolution transaction failed: ${hash}`);
  }

  return {
    transactionHash: hash,
    conditionId,
    questionId,
    outcome
  };
}

export function outcomeSideToResolverOutcome(outcome: string): ResolverOutcome {
  if (outcome === "NO" || outcome === "UNDER") return "TOKEN0";
  if (outcome === "YES" || outcome === "OVER") return "TOKEN1";
  throw new Error(`Unsupported resolution outcome: ${outcome}`);
}

export function hashIdentifier(value: string): Hex {
  return keccak256(stringToHex(value));
}

function findMarketCreatedEvent(receipt: TransactionReceipt, marketFactory: Address) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== marketFactory.toLowerCase()) continue;

    try {
      const decoded = decodeEventLog({
        abi: marketFactoryAbi,
        data: log.data,
        topics: log.topics
      });

      if (decoded.eventName !== "MarketCreated") continue;

      return {
        conditionId: decoded.args.conditionId,
        token0: decoded.args.token0,
        token1: decoded.args.token1
      };
    } catch {
      continue;
    }
  }

  return undefined;
}
