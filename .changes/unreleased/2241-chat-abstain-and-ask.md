---
issue: 2241
section: Changed
---

- Project and discussion chat now answer from the sources: when they don't support an answer the
  reply says so and names what is missing, and an ambiguous question gets one specific follow-up.
  Retrieved excerpts below a relevance floor (`CHAT_RETRIEVAL_MIN_SCORE`, default 0.55, calibrated
  with `pnpm eval:ba-qa --floor-sweep`) no longer reach the prompt. The label under a reply lists
  the files its excerpts came from, and says when the evidence was insufficient, the search failed,
  or only part of the project could be searched.
