-- #149 (epic #130, P4) — GitHub Copilot support removed.
--
-- `ai_sessions.copilotHome` held the per-session COPILOT_HOME directory the
-- GitHub Copilot SDK used (and, under it, the `skills/` materialisation dir
-- the SDK scanned). Nothing reads or writes it once the Copilot provider is
-- gone: skills now reach every provider through METIS's own progressive skill
-- loading (the `load_skill` tool), so the column is dropped.
--
-- Rows are untouched otherwise. A session whose `provider` is still
-- `copilot-native` stays readable and is served read-only by the API (#149).
-- The directories themselves lived on the server's filesystem under
-- `$METIS_SESSIONS_HOME` (default `~/.metis-sessions`); nothing creates them
-- any more and they can be deleted — see docs/MIGRATING_FROM_COPILOT.md.
--
-- Rollback (documentation): `ALTER TABLE "ai_sessions" ADD COLUMN "copilotHome" TEXT;`
-- Lossy only in the sense that the old paths are not restored; nothing used them.

-- AlterTable (SQLite 3.35+ supports DROP COLUMN on an unindexed column)
ALTER TABLE "ai_sessions" DROP COLUMN "copilotHome";
