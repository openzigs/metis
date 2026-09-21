-- CreateTable
CREATE TABLE "config_audit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "oldValueRedacted" TEXT NOT NULL,
    "newValueRedacted" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "config_audit_key_ts_idx" ON "config_audit"("key", "ts");

-- CreateIndex
CREATE INDEX "config_audit_actorId_ts_idx" ON "config_audit"("actorId", "ts");
