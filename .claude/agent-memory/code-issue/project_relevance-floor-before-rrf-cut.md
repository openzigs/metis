---
name: relevance-floor-before-rrf-cut
description: Moving a relevance floor before the RRF cut and re-fusing deeper lists can evict hits already kept; the floor reference must come from user-word hits (#2294, #2416, #2413).
metadata:
  type: project
---

**Backfill can evict.** Moving the relevance floor ahead of an RRF cut and re-fusing deeper lists can push out hits that were already kept: presence in several lists at depth 9-16 outscores a single top-8 hit. Test with **two overlapping user lists** (#2294, #2416), not one.

**Floor reference.** The relative floor's reference score must come from hits matched on the user's own words, not from conversational-only hits, or chatter sets the bar (#2413).
