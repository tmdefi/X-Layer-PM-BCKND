CREATE TABLE "ClobOrder" (
    "id" TEXT NOT NULL,
    "orderHash" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeSide" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "maker" TEXT NOT NULL,
    "signer" TEXT NOT NULL,
    "taker" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "makerAmount" TEXT NOT NULL,
    "takerAmount" TEXT NOT NULL,
    "remainingMaker" TEXT NOT NULL,
    "expiration" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "feeRateBps" TEXT NOT NULL,
    "signatureType" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClobOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClobFill" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "makerAmountFilled" TEXT NOT NULL,
    "takerAmountFilled" TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClobFill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClobTrade" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "takerOrderId" TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "takerFillAmount" TEXT NOT NULL,
    "makerFillAmounts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClobTrade_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClobTradeMaker" (
    "tradeId" TEXT NOT NULL,
    "makerOrderId" TEXT NOT NULL,
    "fillAmount" TEXT NOT NULL,
    CONSTRAINT "ClobTradeMaker_pkey" PRIMARY KEY ("tradeId","makerOrderId")
);

CREATE UNIQUE INDEX "ClobOrder_orderHash_key" ON "ClobOrder"("orderHash");
CREATE INDEX "ClobOrder_marketId_status_outcomeSide_side_idx" ON "ClobOrder"("marketId", "status", "outcomeSide", "side");
CREATE INDEX "ClobOrder_maker_status_idx" ON "ClobOrder"("maker", "status");
CREATE INDEX "ClobFill_orderId_createdAt_idx" ON "ClobFill"("orderId", "createdAt");
CREATE INDEX "ClobFill_tradeId_idx" ON "ClobFill"("tradeId");
CREATE INDEX "ClobTrade_marketId_createdAt_idx" ON "ClobTrade"("marketId", "createdAt");
CREATE INDEX "ClobTrade_transactionHash_idx" ON "ClobTrade"("transactionHash");
CREATE INDEX "ClobTradeMaker_makerOrderId_idx" ON "ClobTradeMaker"("makerOrderId");

ALTER TABLE "ClobOrder" ADD CONSTRAINT "ClobOrder_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClobFill" ADD CONSTRAINT "ClobFill_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ClobOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClobFill" ADD CONSTRAINT "ClobFill_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "ClobTrade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClobTrade" ADD CONSTRAINT "ClobTrade_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClobTrade" ADD CONSTRAINT "ClobTrade_takerOrderId_fkey" FOREIGN KEY ("takerOrderId") REFERENCES "ClobOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClobTradeMaker" ADD CONSTRAINT "ClobTradeMaker_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "ClobTrade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClobTradeMaker" ADD CONSTRAINT "ClobTradeMaker_makerOrderId_fkey" FOREIGN KEY ("makerOrderId") REFERENCES "ClobOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
