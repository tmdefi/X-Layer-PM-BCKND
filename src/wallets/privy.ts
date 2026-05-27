import { PrivyClient } from "@privy-io/node";
import type { Address, Hex } from "viem";
import { env } from "../config/env.js";

type TelegramIdentity = {
  telegramUserId: string;
  username?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  photoUrl?: string | undefined;
};

export type PrivyTelegramWallet = {
  privyUserId: string;
  walletId: string;
  address: Address;
  replacedWalletId?: string | undefined;
  replacedAddress?: Address | undefined;
};

let client: PrivyClient | undefined;

export function privyServerWalletsConfigured(): boolean {
  return Boolean(
    env.PRIVY_SERVER_WALLETS_ENABLED &&
      env.PRIVY_APP_ID &&
      env.PRIVY_APP_SECRET &&
      env.PRIVY_WALLET_SIGNER_ID &&
      env.PRIVY_WALLET_AUTHORIZATION_PRIVATE_KEY
  );
}

export async function getOrCreatePrivyTelegramWallet(input: TelegramIdentity): Promise<PrivyTelegramWallet> {
  const privy = requirePrivyClient();
  const telegramUserId = input.telegramUserId.trim();
  if (!telegramUserId) throw Object.assign(new Error("telegramUserId is required"), { statusCode: 400 });

  const dedicatedWallet = await findPrivyTelegramDedicatedWallet(telegramUserId);
  if (dedicatedWallet) return dedicatedWallet;

  let user = await findPrivyTelegramUser(telegramUserId);
  if (!user) {
    user = await privy.users().create({
      linked_accounts: [
        {
          type: "telegram",
          telegram_user_id: telegramUserId,
          ...(input.username ? { username: input.username } : {}),
          ...(input.firstName ? { first_name: input.firstName } : {}),
          ...(input.lastName ? { last_name: input.lastName } : {}),
          ...(input.photoUrl ? { photo_url: input.photoUrl } : {})
        }
      ],
      custom_metadata: {
        source: "xsporty-telegram"
      },
      wallets: [walletCreationInput()]
    });
  }

  const wallet = findEthereumWallet(user);
  if (wallet) {
    await bestEffortPrivyWalletOwner(wallet.walletId);
    return wallet;
  }

  const updated = await privy.users().pregenerateWallets(user.id, {
    wallets: [walletCreationInput()]
  });
  const generatedWallet = findEthereumWallet(updated);
  if (!generatedWallet) {
    throw Object.assign(new Error("Privy did not return an Ethereum wallet for the Telegram user"), { statusCode: 502 });
  }

  await bestEffortPrivyWalletOwner(generatedWallet.walletId);
  return generatedWallet;
}

export async function getOrCreateExportablePrivyTelegramWallet(input: TelegramIdentity): Promise<PrivyTelegramWallet> {
  const wallet = await getOrCreatePrivyTelegramWallet(input);
  try {
    await ensurePrivyWalletOwner(wallet.walletId);
    return wallet;
  } catch (error) {
    if (!isLegacyNonExportableWallet(error)) throw error;
    return await createDedicatedPrivyTelegramWallet(input, wallet);
  }
}

export async function signPrivyTypedData(walletId: string, typedData: unknown): Promise<Hex> {
  const response = await requirePrivyClient().wallets().ethereum().signTypedData(walletId, {
    authorization_context: authorizationContext(),
    params: {
      typed_data: privyTypedData(typedData) as never
    }
  });
  return response.signature as Hex;
}

export async function sendPrivyTransaction(walletId: string, tx: { to: Address; data: Hex; value?: Hex | undefined }) {
  const response = await requirePrivyClient().wallets().ethereum().sendTransaction(walletId, {
    authorization_context: authorizationContext(),
    caip2: `eip155:${env.XLAYER_CHAIN_ID}`,
    params: {
      transaction: {
        to: tx.to,
        data: tx.data,
        ...(tx.value ? { value: tx.value } : {})
      }
    }
  });
  return response.hash as Hex;
}

export async function exportPrivyWalletPrivateKey(walletId: string): Promise<string> {
  try {
    return await exportPrivyWalletPrivateKeyOnce(walletId);
  } catch (error) {
    if (!isMissingExportAuthorization(error)) throw error;
    await ensurePrivyWalletOwner(walletId);
    return await exportPrivyWalletPrivateKeyOnce(walletId);
  }
}

function requirePrivyClient(): PrivyClient {
  if (!privyServerWalletsConfigured()) {
    throw Object.assign(new Error("Privy server wallets are not configured"), { statusCode: 503 });
  }
  client ??= new PrivyClient({
    appId: privyEnv("PRIVY_APP_ID"),
    appSecret: privyEnv("PRIVY_APP_SECRET")
  });
  return client;
}

async function findPrivyTelegramUser(telegramUserId: string) {
  try {
    return await requirePrivyClient().users().getByTelegramUserID({ telegram_user_id: telegramUserId });
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function walletCreationInput() {
  return {
    chain_type: "ethereum" as const,
    additional_signers: [
      {
        signer_id: privyEnv("PRIVY_WALLET_SIGNER_ID"),
        ...(env.PRIVY_WALLET_POLICY_ID ? { override_policy_ids: [env.PRIVY_WALLET_POLICY_ID] } : {})
      }
    ]
  };
}

function dedicatedWalletCreationInput(telegramUserId: string) {
  return {
    chain_type: "ethereum" as const,
    display_name: `Telegram ${telegramUserId}`,
    external_id: dedicatedWalletExternalId(telegramUserId),
    owner_id: privyEnv("PRIVY_WALLET_SIGNER_ID"),
    ...(env.PRIVY_WALLET_POLICY_ID ? { policy_ids: [env.PRIVY_WALLET_POLICY_ID] } : {})
  };
}

async function findPrivyTelegramDedicatedWallet(telegramUserId: string): Promise<PrivyTelegramWallet | undefined> {
  const externalId = dedicatedWalletExternalId(telegramUserId);
  for await (const wallet of requirePrivyClient().wallets().list({
    chain_type: "ethereum",
    external_id: externalId
  })) {
    if (isWalletRecord(wallet)) {
      return {
        privyUserId: `telegram:${telegramUserId}`,
        walletId: wallet.id,
        address: wallet.address
      };
    }
  }
  return undefined;
}

async function createDedicatedPrivyTelegramWallet(
  input: TelegramIdentity,
  replacedWallet: PrivyTelegramWallet
): Promise<PrivyTelegramWallet> {
  const telegramUserId = input.telegramUserId.trim();
  const existing = await findPrivyTelegramDedicatedWallet(telegramUserId);
  if (existing) return existing;

  try {
    const wallet = await requirePrivyClient().wallets().create(dedicatedWalletCreationInput(telegramUserId));
    if (!isWalletRecord(wallet)) {
      throw Object.assign(new Error("Privy did not return an Ethereum wallet for the Telegram user"), { statusCode: 502 });
    }
    return {
      privyUserId: `telegram:${telegramUserId}`,
      walletId: wallet.id,
      address: wallet.address,
      replacedWalletId: replacedWallet.walletId,
      replacedAddress: replacedWallet.address
    };
  } catch (error) {
    if (!isResourceConflict(error)) throw error;
    const existingAfterConflict = await findPrivyTelegramDedicatedWallet(telegramUserId);
    if (existingAfterConflict) return existingAfterConflict;
    throw error;
  }
}

function authorizationContext() {
  return {
    authorization_private_keys: [privyEnv("PRIVY_WALLET_AUTHORIZATION_PRIVATE_KEY")]
  };
}

async function exportPrivyWalletPrivateKeyOnce(walletId: string): Promise<string> {
  const response = await requirePrivyClient().wallets().exportPrivateKey(walletId, {
    authorization_context: authorizationContext()
  });
  return response.private_key;
}

async function ensurePrivyWalletOwner(walletId: string) {
  try {
    await requirePrivyClient().wallets().update(walletId, {
      owner_id: privyEnv("PRIVY_WALLET_SIGNER_ID"),
      authorization_context: authorizationContext()
    });
  } catch (error) {
    if (!isMissingExportAuthorization(error)) throw error;
    await rawSetPrivyWalletOwner(walletId);
  }
}

async function bestEffortPrivyWalletOwner(walletId: string) {
  try {
    await ensurePrivyWalletOwner(walletId);
  } catch {
    // Wallet ownership only affects private-key export; do not block normal bot use.
  }
}

async function rawSetPrivyWalletOwner(walletId: string) {
  const wallets = requirePrivyClient().wallets() as unknown as {
    _update: (walletId: string, params: { owner_id: string }) => Promise<unknown>;
  };
  try {
    await wallets._update(walletId, {
      owner_id: privyEnv("PRIVY_WALLET_SIGNER_ID")
    });
  } catch (error) {
    if (!isMissingExportAuthorization(error)) throw error;
    throw Object.assign(
      new Error("This bot wallet was created before private-key export ownership was enabled. Create a new bot wallet or migrate this wallet owner in Privy before exporting."),
      { statusCode: 409 }
    );
  }
}

function privyTypedData(typedData: unknown) {
  if (!isRecord(typedData)) return typedData;
  const { primaryType, ...rest } = typedData;
  return {
    ...rest,
    ...(typeof primaryType === "string" ? { primary_type: primaryType } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function privyEnv(
  key: "PRIVY_APP_ID" | "PRIVY_APP_SECRET" | "PRIVY_WALLET_SIGNER_ID" | "PRIVY_WALLET_AUTHORIZATION_PRIVATE_KEY"
): string {
  const value = env[key];
  if (!value) throw Object.assign(new Error(`${key} is required for Privy server wallets`), { statusCode: 503 });
  return value;
}

function findEthereumWallet(user: { id: string; linked_accounts: unknown[] }): PrivyTelegramWallet | undefined {
  const wallet = user.linked_accounts.find((account) => {
    const candidate = account as { type?: string; chain_type?: string; id?: string; address?: string };
    return (
      candidate.type === "wallet" &&
      candidate.chain_type === "ethereum" &&
      typeof candidate.id === "string" &&
      isAddress(candidate.address)
    );
  }) as { id: string; address: Address } | undefined;

  return wallet
    ? {
        privyUserId: user.id,
        walletId: wallet.id,
        address: wallet.address
      }
    : undefined;
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isWalletRecord(value: unknown): value is { id: string; address: Address; chain_type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { chain_type?: string }).chain_type === "ethereum" &&
    typeof (value as { id?: unknown }).id === "string" &&
    isAddress((value as { address?: unknown }).address)
  );
}

function dedicatedWalletExternalId(telegramUserId: string) {
  return `xcup_tg_${telegramUserId.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ("status" in error || "statusCode" in error) &&
    ((error as { status?: number }).status === 404 || (error as { statusCode?: number }).statusCode === 404)
  );
}

function isResourceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const status = typeof error === "object" && error !== null
    ? (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode
    : undefined;
  return status === 409 || message.includes("resource_conflict") || message.includes("already exists");
}

function isLegacyNonExportableWallet(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    isMissingExportAuthorization(error) ||
    message.includes("created before private-key export ownership was enabled") ||
    message.includes("migrate this wallet owner")
  );
}

function isMissingExportAuthorization(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const status = typeof error === "object" && error !== null
    ? (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode
    : undefined;
  return status === 401 || message.includes("No valid authorization keys or user signing keys available");
}
