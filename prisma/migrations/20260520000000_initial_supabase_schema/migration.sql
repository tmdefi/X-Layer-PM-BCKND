CREATE TABLE "Fixture" (
    "id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "homeCompetitor" TEXT NOT NULL,
    "awayCompetitor" TEXT NOT NULL,
    "homeLogoUrl" TEXT,
    "awayLogoUrl" TEXT,
    "kickoffTime" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fixture_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" JSONB,
    "resolver" JSONB,
    "outcomes" JSONB NOT NULL,
    "conditionId" TEXT,
    "template" JSONB,
    "sport" TEXT,
    "line" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Resolution" (
    "marketId" TEXT NOT NULL,
    "marketType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "payoutVector" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resolution_pkey" PRIMARY KEY ("marketId")
);

CREATE TABLE "FixtureInsightsCache" (
    "cacheKey" TEXT NOT NULL,
    "insights" JSONB NOT NULL,
    "cachedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixtureInsightsCache_pkey" PRIMARY KEY ("cacheKey")
);

CREATE TABLE "ProviderSyncLog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "details" JSONB,

    CONSTRAINT "ProviderSyncLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Fixture_sport_kickoffTime_idx" ON "Fixture"("sport", "kickoffTime");
CREATE INDEX "Fixture_status_kickoffTime_idx" ON "Fixture"("status", "kickoffTime");
CREATE INDEX "Market_fixtureId_idx" ON "Market"("fixtureId");
CREATE INDEX "Market_status_idx" ON "Market"("status");
CREATE INDEX "Market_type_idx" ON "Market"("type");
CREATE INDEX "Resolution_status_idx" ON "Resolution"("status");
CREATE INDEX "Resolution_computedAt_idx" ON "Resolution"("computedAt");
CREATE INDEX "FixtureInsightsCache_expiresAt_idx" ON "FixtureInsightsCache"("expiresAt");
CREATE INDEX "ProviderSyncLog_provider_jobType_startedAt_idx" ON "ProviderSyncLog"("provider", "jobType", "startedAt");
CREATE INDEX "ProviderSyncLog_status_startedAt_idx" ON "ProviderSyncLog"("status", "startedAt");

ALTER TABLE "Market" ADD CONSTRAINT "Market_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Resolution" ADD CONSTRAINT "Resolution_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
