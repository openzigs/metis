-- Epic #547 (Phase 2, #550) — DiscussionMessage origin / loop-guard column.
--
-- Adds `discussion_messages.origin` (default 'metis'). Outbound Teams mirroring
-- (#550) skips rows whose origin is 'teams' so a message ingested from a linked
-- Teams channel (set by inbound sync #551) is never echoed back out — the
-- bidirectional-bridge loop guard. ADDITIVE: existing rows backfill to 'metis'
-- via the column default.
ALTER TABLE "discussion_messages" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'metis';
