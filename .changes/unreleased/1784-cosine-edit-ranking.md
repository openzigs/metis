---
issue: 1784
section: Changed
---

- `IMPACT_REQUEST_EDIT_RANKING` (still off by default) now ranks the files to edit across a
  request's changes and projects by how close each project's best code match is to the request
  (the vector similarity), not by the search's rank-based score, which reads the same for every
  project's best match. Measured as arm A12 of `pnpm eval:localization`: Recall@5 holds and edit
  precision rises from 0.17 to 0.30 on the held-out Miniflux set, but on the portfolio fixture a
  one-repository answer still names files in other repositories on most requirements, so it stays
  off. The localization report now counts, for a portfolio, the requirements whose edit
  candidates stayed in the answer's repository.
