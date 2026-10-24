---
name: review-heuristics-hidden-uniqueness-and-dead-claims
description: Review checks that found real bugs in the 2026-10-24 wave — a narrowed key unmasks downstream uniqueness layers, a repurposed dedup changes fail-open meaning, declared paths with no call site, and slimmed list responses (#1491, #1493, #1503, #1508).
metadata:
  type: project
---

From reviews of #1491, #1493, #1503 and #1508 (2026-10-24).

- **A narrowed dedup/uniqueness key unmasks the layers the broader key hid.** When #1506
  scoped delivery dedup per receiver and signer, three downstream layers still collapsed per
  event: the PR-review queue supersede key `owner/repo#pr` (no projectId),
  `DriftEvent.deliveryId @unique` on the bare GUID, and per-connector (not per-project)
  own-secret exclusion in `findProjectForRepo`. Queue-stubbing tests cannot catch these; walk
  every key from receiver to the last write (#1508 review).
- **Repurposing changes the failure mode.** A dedup built for reliability that becomes the
  only replay guard must fail closed (#1491 review; detail in
  [[github-webhook-dedup-and-routing]]).
- **Declared is not wired.** A declared `BackgroundPath` member, or a PR-body "the skip is
  logged" claim, can have no call site. Grep the logger (`logDeletedProjectSkip`) to confirm
  each declared path really logs (#1493 review).
- **Slimming a list response to a summary type**: check every UI place that took the full
  object from that list (e.g. an edit dialog). On #1503 it was safe only by row-order luck.

Related: [[test-falsifiability-traps]], [[verify-issue-premise-before-copy]].
