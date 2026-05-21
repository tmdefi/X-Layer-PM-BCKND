import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../config/env.js";

export type ChainClients = ReturnType<typeof createChainClients>;

export function createChainClients() {
  if (!env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY is required for contract writes");
  }

  const chain = {
    id: env.XLAYER_CHAIN_ID,
    name: env.XLAYER_CHAIN_ID === 196 ? "X Layer" : "X Layer Testnet",
    nativeCurrency: {
      name: "OKB",
      symbol: "OKB",
      decimals: 18
    },
    rpcUrls: {
      default: {
        http: [env.XLAYER_RPC_URL]
      }
    }
  } as const;

  const account = privateKeyToAccount(env.PRIVATE_KEY as Hex);
  const transport = http(env.XLAYER_RPC_URL);

  return {
    account,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account, chain, transport })
  };
}

export function requireAddress(value: string | undefined, name: string): Address {
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value as Address;
}

