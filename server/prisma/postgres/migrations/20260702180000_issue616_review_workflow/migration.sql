-- Issue #616 (epic #609) -- formal review & approval workflow + baselines.
-- Postgres mirror of the SQLite migration.
--
-- Adds `review_requests`, `review_request_items`, `reviewer_assignments`,
-- `baselines`, and `baseline_items`. ADDITIVE -- no existing table is altered.
-- All structural DDL is idempotent (`IF NOT EXISTS`; FKs are wrapped in
-- pg_constraint existence DO-blocks) so the full migration history replays
-- cleanly over the cumulative `00000000000000_init` baseline on a fresh
-- Postgres (#556 guard).

-- CreateTable
CREATE TABLE IF NOT EXISTS "review_requests" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "policy" TEXT NOT NULL DEFAULT 'all',
    "quorum" INTEGER,
    "requestedById" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "review_request_items" (
    "id" TEXT NOT NULL,
    "reviewRequestId" TEXT NOT NULL,
    "requirementId" TEXT,
    "generatedDocumentId" TEXT,
    "pinnedVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "reviewer_assignments" (
    "id" TEXT NOT NULL,
    "reviewRequestId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviewer_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "baselines" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "reviewRequestId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baselines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "baseline_items" (
    "id" TEXT NOT NULL,
    "baselineId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baseline_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "review_requests_projectId_status_idx" ON "review_requests"("projectId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "review_requests_requestedById_idx" ON "review_requests"("requestedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "review_request_items_requirementId_idx" ON "review_request_items"("requirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "review_request_items_generatedDocumentId_idx" ON "review_request_items"("generatedDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "review_request_items_reviewRequestId_requirementId_key" ON "review_request_items"("reviewRequestId", "requirementId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "review_request_items_reviewRequestId_generatedDocumentId_key" ON "review_request_items"("reviewRequestId", "generatedDocumentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reviewer_assignments_reviewerId_decision_idx" ON "reviewer_assignments"("reviewerId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "reviewer_assignments_reviewRequestId_reviewerId_key" ON "reviewer_assignments"("reviewRequestId", "reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "baselines_reviewRequestId_key" ON "baselines"("reviewRequestId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "baselines_projectId_name_key" ON "baselines"("projectId", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "baseline_items_requirementId_idx" ON "baseline_items"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "baseline_items_baselineId_requirementId_key" ON "baseline_items"("baselineId", "requirementId");

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_requests_projectId_fkey') THEN
    ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_requests_requestedById_fkey') THEN
    ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_request_items_reviewRequestId_fkey') THEN
    ALTER TABLE "review_request_items" ADD CONSTRAINT "review_request_items_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "review_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_request_items_requirementId_fkey') THEN
    ALTER TABLE "review_request_items" ADD CONSTRAINT "review_request_items_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_request_items_generatedDocumentId_fkey') THEN
    ALTER TABLE "review_request_items" ADD CONSTRAINT "review_request_items_generatedDocumentId_fkey" FOREIGN KEY ("generatedDocumentId") REFERENCES "generated_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_assignments_reviewRequestId_fkey') THEN
    ALTER TABLE "reviewer_assignments" ADD CONSTRAINT "reviewer_assignments_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "review_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_assignments_reviewerId_fkey') THEN
    ALTER TABLE "reviewer_assignments" ADD CONSTRAINT "reviewer_assignments_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'baselines_projectId_fkey') THEN
    ALTER TABLE "baselines" ADD CONSTRAINT "baselines_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'baselines_reviewRequestId_fkey') THEN
    ALTER TABLE "baselines" ADD CONSTRAINT "baselines_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "review_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'baselines_createdById_fkey') THEN
    ALTER TABLE "baselines" ADD CONSTRAINT "baselines_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'baseline_items_baselineId_fkey') THEN
    ALTER TABLE "baseline_items" ADD CONSTRAINT "baseline_items_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "baselines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'baseline_items_requirementId_fkey') THEN
    ALTER TABLE "baseline_items" ADD CONSTRAINT "baseline_items_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

