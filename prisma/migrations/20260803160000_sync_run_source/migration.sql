-- AlterTable
ALTER TABLE "SyncRun" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'volkova';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SyncRun_source_startedAt_idx" ON "SyncRun"("source", "startedAt");
