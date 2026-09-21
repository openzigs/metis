-- Epic #204 follow-up (#252): dedicated structured-warnings column for
-- degraded GeneratedDocuments. Moves the `DocWarning[]` payload off the
-- overloaded `errorMessage` field into its own JSON column so diagnostic
-- warnings never collide with genuine error strings and `status` stays a clean
-- state-machine field (pending|generating|ready|degraded|failed).

-- AlterTable
ALTER TABLE "generated_documents" ADD COLUMN     IF NOT EXISTS "warnings" JSONB;
