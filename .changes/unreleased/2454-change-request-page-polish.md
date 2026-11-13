---
issue: 2454
section: Changed
---

- The change request page's heading has its full width again: the project budget and the
  deployment-wide cap now sit under the description instead of beside the
  **New change request** button.
- A project created **Documents only** is no longer warned that it has no code graph and no
  ingested source code, before a run or after one. Its change request's Impact step reads
  "This project has no code connected." instead of "The affected code was mapped."
- Requirements that are not in any review read **Draft** instead of "Awaiting review", on the
  Requirements list, its status filter and the Requirements overview. A row a review covers
  still says "In review" beside it.
- The Request review form no longer mentions "the rest" when every requirement is in the review.
  It says how many will show as in review.
