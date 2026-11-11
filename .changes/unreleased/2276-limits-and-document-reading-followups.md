---
issue: 2276
section: Fixed
---

- Regenerating one agent now updates the run's "findings not saved" notice: it
  names what the new answer left out at the 50-finding limit, or clears the
  notice when nothing was left out. Before, the notice kept describing the
  answer the regenerate replaced.
- When the code agent's answer had to be recovered and held more than 50
  findings, the findings past the 50th are now named on the run instead of
  being dropped without a word.
- The Analysis limits panel skips a malformed stored entry instead of failing
  to render.
- An impact analysis no longer pays to read a document when none of its
  projects will be searched (each one restricted, deleted or not indexed). The
  reading is billed to the first project that is searched, and the run shows
  "Reading the document" while it reads.
- An impact run that never reads a document (short pasted text, an issue,
  stored requirements) no longer lists "document reading" among the AI steps
  that did not run when no AI provider is configured.
- A change read from a document is typed (added, modified, removed) from the
  document's own words, as the paragraph splitter types it, not from the
  model's restatement: a retention rule is no longer reported as a removal.
