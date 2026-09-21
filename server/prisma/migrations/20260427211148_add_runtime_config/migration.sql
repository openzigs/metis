-- CreateTable
CREATE TABLE "runtime_config" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "updatedById" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "runtime_config_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "runtime_config_scope_idx" ON "runtime_config"("scope");
