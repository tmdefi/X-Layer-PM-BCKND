import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";

type Artifact = {
  abi: readonly unknown[];
  bytecode: { object: Hex };
};

const artifactRoot = process.env.CTF_ARTIFACT_ROOT
  ?? join(process.cwd(), "..", "ctf-exchange-main", "out");
const legacyArtifactRoot = process.env.CTF_LEGACY_ARTIFACT_ROOT
  ?? join(process.cwd(), "..", "ctf-exchange-main", "artifacts");

const exchangeArtifact = readArtifact("CTFExchange.sol", "CTFExchange.json");
const resolverArtifact = readArtifact("BinaryMarketResolver.sol", "BinaryMarketResolver.json");
const factoryArtifact = readArtifact("MarketFactory.sol", "MarketFactory.json");
const conditionalTokensArtifact = readLegacyArtifact("ConditionalTokens.json");

const privateKey = env.PRIVATE_KEY as Hex | undefined;
if (!privateKey) throw new Error("PRIVATE_KEY is required to deploy the new USDC stack");

const collateral = requireConfiguredAddress(env.COLLATERAL_TOKEN_ADDRESS, "COLLATERAL_TOKEN_ADDRESS");
const admin = requireConfiguredAddress(env.ADMIN_ADDRESS, "ADMIN_ADDRESS");
const account = privateKeyToAccount(privateKey);
const chain = {
  id: env.XLAYER_CHAIN_ID,
  name: env.XLAYER_CHAIN_ID === 196 ? "X Layer" : "X Layer Custom",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [env.XLAYER_RPC_URL] } }
} as const;
const publicClient = createPublicClient({ chain, transport: http(env.XLAYER_RPC_URL) });
const walletClient = createWalletClient({ account, chain, transport: http(env.XLAYER_RPC_URL) });

const conditionalTokens = await existingOrDeploy(
  "ConditionalTokens",
  env.CONDITIONAL_TOKENS_ADDRESS,
  conditionalTokensArtifact,
  []
);
const exchange = await deploy("CTFExchange", exchangeArtifact, [collateral, conditionalTokens]);
await write("CTFExchange.addAdmin", exchange, exchangeArtifact.abi, "addAdmin", [admin]);
await write("CTFExchange.addOperator", exchange, exchangeArtifact.abi, "addOperator", [admin]);

const resolver = await deploy("BinaryMarketResolver", resolverArtifact, [conditionalTokens]);
await write("BinaryMarketResolver.setResolver", resolver, resolverArtifact.abi, "setResolver", [admin, true]);
await write("BinaryMarketResolver.transferOwnership", resolver, resolverArtifact.abi, "transferOwnership", [admin]);

const marketFactory = await deploy("MarketFactory", factoryArtifact, [collateral, conditionalTokens, exchange]);
await write("CTFExchange.addAdmin(factory)", exchange, exchangeArtifact.abi, "addAdmin", [marketFactory]);

console.log(JSON.stringify({
  collateralToken: collateral,
  conditionalTokens,
  ctfExchange: exchange,
  binaryMarketResolver: resolver,
  marketFactory
}, null, 2));

function readArtifact(directory: string, file: string): Artifact {
  return JSON.parse(readFileSync(join(artifactRoot, directory, file), "utf8")) as Artifact;
}

function readLegacyArtifact(file: string): Artifact {
  return JSON.parse(readFileSync(join(legacyArtifactRoot, file), "utf8")) as Artifact;
}

async function existingOrDeploy(
  name: string,
  configuredAddress: string | undefined,
  artifact: Artifact,
  args: readonly unknown[]
): Promise<Address> {
  if (!configuredAddress) return deploy(name, artifact, args);
  const address = configuredAddress as Address;
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") {
    console.warn(`${name} address ${address} has no bytecode; deploying a new ${name}`);
    return deploy(name, artifact, args);
  }
  console.log(`${name} already deployed at ${address}; reusing it`);
  return address;
}

async function deploy(name: string, artifact: Artifact, args: readonly unknown[]): Promise<Address> {
  const hash = await withNonceRetry(() => walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args,
      account
    }), async () => walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args,
      account,
      nonce: await pendingNonce()
    })
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${name} deployment failed: ${hash}`);
  }
  return receipt.contractAddress;
}

async function write(
  label: string,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[]
) {
  const hash = await withNonceRetry(() => walletClient.writeContract({
      address,
      abi,
      functionName,
      args,
      account
    }), async () => walletClient.writeContract({
      address,
      abi,
      functionName,
      args,
      account,
      nonce: await pendingNonce()
    })
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
}

async function withNonceRetry<T>(
  firstAttempt: () => Promise<T>,
  retryAttempt: () => Promise<T>
): Promise<T> {
  try {
    return await firstAttempt();
  } catch (error) {
    if (!isNonceTooLowError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return retryAttempt();
  }
}

async function pendingNonce() {
  return publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending"
  });
}

function isNonceTooLowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /nonce (provided .* lower|too low|has already been used)/i.test(message);
}

function requireConfiguredAddress(value: string | undefined, name: string): Address {
  if (!value) throw new Error(`${name} is required`);
  return value as Address;
}
