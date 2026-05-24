CREATE TABLE "PlayerCandidateCache" (
  "cacheKey" TEXT NOT NULL,
  "candidates" JSONB NOT NULL,
  "cachedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PlayerCandidateCache_pkey" PRIMARY KEY ("cacheKey")
);

CREATE INDEX "PlayerCandidateCache_expiresAt_idx"
ON "PlayerCandidateCache"("expiresAt");
