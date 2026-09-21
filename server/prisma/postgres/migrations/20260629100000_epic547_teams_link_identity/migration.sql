-- Epic #547 (Phase 1, #549) — Teams thread↔channel link + AAD→METIS identity.
-- Postgres mirror of the SQLite migration.
--
-- Adds the `teams_channel_links` + `teams_user_identities` tables. ADDITIVE — no
-- existing table is altered. All structural DDL is idempotent
-- (`IF NOT EXISTS`; FKs wrapped in pg_constraint existence DO-blocks) so the full
-- migration history replays cleanly over the cumulative `00000000000000_init`
-- baseline on a fresh Postgres (issue #556 guard).

-- CreateTable
CREATE TABLE IF NOT EXISTS "teams_channel_links" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "tenantId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_channel_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "teams_user_identities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "aadObjectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "teams_channel_links_workspaceId_idx" ON "teams_channel_links"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "teams_channel_links_projectId_idx" ON "teams_channel_links"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "teams_channel_links_workspaceId_conversationId_key" ON "teams_channel_links"("workspaceId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "teams_channel_links_threadId_key" ON "teams_channel_links"("threadId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "teams_user_identities_workspaceId_idx" ON "teams_user_identities"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "teams_user_identities_userId_idx" ON "teams_user_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "teams_user_identities_tenantId_aadObjectId_key" ON "teams_user_identities"("tenantId", "aadObjectId");

-- AddForeignKey (guarded — bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_channel_links_workspaceId_fkey') THEN
    ALTER TABLE "teams_channel_links" ADD CONSTRAINT "teams_channel_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_channel_links_threadId_fkey') THEN
    ALTER TABLE "teams_channel_links" ADD CONSTRAINT "teams_channel_links_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_channel_links_createdById_fkey') THEN
    ALTER TABLE "teams_channel_links" ADD CONSTRAINT "teams_channel_links_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_user_identities_workspaceId_fkey') THEN
    ALTER TABLE "teams_user_identities" ADD CONSTRAINT "teams_user_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_user_identities_userId_fkey') THEN
    ALTER TABLE "teams_user_identities" ADD CONSTRAINT "teams_user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
