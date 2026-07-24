CREATE TABLE "SyncRun" (
  "id" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "productsFound" INTEGER NOT NULL DEFAULT 0,
  "productsAdded" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);
