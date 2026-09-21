-- Epic #201 (#210) — durable clarification dialog state. Replaces the prior
-- in-memory Map so in-flight clarification survives a server restart.

-- CreateTable
CREATE TABLE IF NOT EXISTS "clarification_dialog_states" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clarification_dialog_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "clarification_dialog_states_analysisId_key" ON "clarification_dialog_states"("analysisId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clarification_dialog_states_analysisId_fkey') THEN
    EXECUTE 'ALTER TABLE "clarification_dialog_states" ADD CONSTRAINT "clarification_dialog_states_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
