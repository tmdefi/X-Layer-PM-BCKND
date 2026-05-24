CREATE TABLE "OperatorTransaction" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "txHash" TEXT,
  "metadata" JSONB,
  "error" TEXT,
  "submittedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OperatorTransaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperatorTransaction_action_entityId_status_idx"
ON "OperatorTransaction"("action", "entityId", "status");

CREATE INDEX "OperatorTransaction_status_updatedAt_idx"
ON "OperatorTransaction"("status", "updatedAt");

CREATE INDEX "OperatorTransaction_txHash_idx"
ON "OperatorTransaction"("txHash");
