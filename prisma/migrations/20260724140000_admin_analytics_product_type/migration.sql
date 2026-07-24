-- AlterTable
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "productType" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_productType_idx" ON "Product"("productType");

-- CreateTable
CREATE TABLE IF NOT EXISTS "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sessionId" TEXT,
    "productId" TEXT,
    "productName" TEXT,
    "path" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_type_createdAt_idx" ON "AnalyticsEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_productId_idx" ON "AnalyticsEvent"("productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_sessionId_idx" ON "AnalyticsEvent"("sessionId");

-- CreateTable
CREATE TABLE IF NOT EXISTS "SyncAddition" (
    "id" TEXT NOT NULL,
    "syncRunId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "sku" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncAddition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SyncAddition_syncRunId_idx" ON "SyncAddition"("syncRunId");

DO $$ BEGIN
  ALTER TABLE "SyncAddition"
    ADD CONSTRAINT "SyncAddition_syncRunId_fkey"
    FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;