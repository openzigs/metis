-- Epic #395 — Code-execution sandbox MVP.
-- Closes #410 (Prisma schema for SandboxSession, SandboxAuditEvent, and
-- per-Project sandbox provider config).
--
-- Three changes:
--   1. ALTER `projects` to add `sandboxProvider`, `sandboxTimeoutMs`,
--      `sandboxEgressAllowlist` (per-Project sandbox configuration).
--   2. CREATE `sandbox_sessions` — one row per `provider.create()`
--      lifecycle (provider, vendor sandbox id, vCPUs, mem, outcome, etc.).
--   3. CREATE `sandbox_audit_events` — append-only audit trail for SOC 2
--      evidence. `payload` is JSON-encoded (TEXT) and is redacted by
--      `sandbox/audit/redact.ts` before persistence.
--
-- All columns use SQLite-portable types (no JSON, no String[], no
-- Decimal, no enums) — keeps the Postgres twin in lockstep per the
-- schema-parity contract from PR #397.

-- ----------------------------------------------------------------------------
-- Project sandbox configuration columns
-- ----------------------------------------------------------------------------
ALTER TABLE "projects" ADD COLUMN "sandboxProvider" TEXT NOT NULL DEFAULT 'e2b';
ALTER TABLE "projects" ADD COLUMN "sandboxTimeoutMs" INTEGER NOT NULL DEFAULT 60000;
ALTER TABLE "projects" ADD COLUMN "sandboxEgressAllowlist" TEXT NOT NULL DEFAULT '[]';

-- ----------------------------------------------------------------------------
-- SandboxSession (one row per create/destroy lifecycle)
-- ----------------------------------------------------------------------------
CREATE TABLE "sandbox_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "vendorSandboxId" TEXT NOT NULL,
    "templateId" TEXT,
    "vCpus" INTEGER NOT NULL,
    "memMiB" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destroyedAt" DATETIME,
    "wallClockMs" INTEGER,
    "cpuTimeMs" INTEGER,
    "costMicroUsd" INTEGER,
    "outcome" TEXT,
    "errorMessage" TEXT,
    CONSTRAINT "sandbox_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "sandbox_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "sandbox_sessions_projectId_createdAt_idx" ON "sandbox_sessions"("projectId", "createdAt");
CREATE INDEX "sandbox_sessions_userId_createdAt_idx" ON "sandbox_sessions"("userId", "createdAt");

-- ----------------------------------------------------------------------------
-- SandboxAuditEvent (append-only)
-- ----------------------------------------------------------------------------
CREATE TABLE "sandbox_audit_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sandbox_audit_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sandbox_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "sandbox_audit_events_sessionId_timestamp_idx" ON "sandbox_audit_events"("sessionId", "timestamp");
CREATE INDEX "sandbox_audit_events_eventType_timestamp_idx" ON "sandbox_audit_events"("eventType", "timestamp");
