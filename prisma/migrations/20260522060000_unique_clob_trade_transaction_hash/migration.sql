DROP INDEX IF EXISTS "ClobTrade_transactionHash_idx";

CREATE UNIQUE INDEX "ClobTrade_transactionHash_key"
ON "ClobTrade"("transactionHash");
