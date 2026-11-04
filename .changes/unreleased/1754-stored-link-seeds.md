---
issue: 1754
section: Added
---

- Impact analysis can start from requirements METIS already tracks: `POST /api/impact-analyses`
  accepts `requirementIds` (up to 50), each analysed as one change, and refuses any requirement
  whose project the caller cannot open. Behind `IMPACT_STORED_LINK_SEEDS` (off by default), such a
  run also seeds the files to edit from each requirement's stored code links, after the search's
  own picks; links to files no longer in the code are skipped and counted in the run summary.
