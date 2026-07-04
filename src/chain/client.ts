import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../config/env.js";

export type ChainClients = ReturnType<typeof createChainClients>;

export function createChainClients() {
  if (!env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY is required for contract writes");
  }

  const account = privateKeyToAccount(env.PRIVATE_KEY as Hex);

  return {
    account,
    publicClient: createPublicChainClient(),
    walletClient: createWalletClient({ account, chain: arcTestnetChain(), transport: http(env.ARC_RPC_URL) })
  };
}

export function createPublicChainClient() {
  return createPublicClient({
    chain: arcTestnetChain(),
    transport: http(env.ARC_RPC_URL)
  });
}

export function requireAddress(value: string | undefined, name: string): Address {
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value as Address;
}

export function arcTestnetChain() {
  return {
    id: env.ARC_CHAIN_ID,
    name: env.ARC_CHAIN_NAME,
    nativeCurrency: {
      name: env.ARC_NATIVE_CURRENCY_NAME,
      symbol: env.ARC_NATIVE_CURRENCY_SYMBOL,
      decimals: env.ARC_NATIVE_CURRENCY_DECIMALS
    },
    rpcUrls: {
      default: {
        http: [env.ARC_RPC_URL]
      }
    },
    blockExplorers: {
      default: {
        name: "Arcscan",
        url: env.ARC_EXPLORER_URL
      }
    }
  } as const;
}
