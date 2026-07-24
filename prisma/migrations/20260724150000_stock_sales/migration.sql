-- AlterTable
ALTER TABLE "SyncRun" ADD COLUMN IF NOT EXISTS "productsUnavailable" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_available_idx" ON "Product"("available");

-- CreateTable
CREATE TABLE IF NOT EXISTS "SyncSighting" (
    "id" TEXT NOT NULL,
    "syncRunId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,

    CONSTRAINT "SyncSighting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SyncSighting_syncRunId_sku_key" ON "SyncSighting"("syncRunId", "sku");
CREATE INDEX IF NOT EXISTS "SyncSighting_syncRunId_idx" ON "SyncSighting"("syncRunId");

DO $$ BEGIN
  ALTER TABLE "SyncSighting"
    ADD CONSTRAINT "SyncSighting_syncRunId_fkey"
    FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Sale" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "priceUsd" DECIMAL(12,2),
    "note" TEXT,
    "soldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Sale_soldAt_idx" ON "Sale"("soldAt");
CREATE INDEX IF NOT EXISTS "Sale_productId_idx" ON "Sale"("productId");

DO $$ BEGIN
  ALTER TABLE "Sale"
    ADD CONSTRAINT "Sale_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
