-- Server-authored policy only; do not backfill from untrusted scopeFilter.actorId.
ALTER TABLE "generated_documents" ADD COLUMN IF NOT EXISTS "evidencePolicy" TEXT;