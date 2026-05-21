ALTER TABLE "Market"
ADD COLUMN "tradingStatus" TEXT NOT NULL DEFAULT 'closed',
ADD COLUMN "tradingStatusReason" TEXT,
ADD COLUMN "tradingStatusUpdatedAt" TIMESTAMP(3);

UPDATE "Market"
SET "tradingStatus" = 'open'
WHERE "status" = 'open';

CREATE INDEX "Market_tradingStatus_idx" ON "Market"("tradingStatus");
