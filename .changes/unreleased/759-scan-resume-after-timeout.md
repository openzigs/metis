---
issue: 759
section: Fixed
---

- A bug scan of a large repository no longer stops after five minutes. Each scan attempt now
  has a two-hour time limit. A retried attempt resumes from the last finished symbol instead of
  starting again from the first one. Finished symbols are not scanned or billed twice, and their
  findings are not duplicated. The scan's token and cost totals now match the usage the project
  recorded across every attempt. When an attempt times out, the scan page says so, with how far
  the scan got, instead of showing "Request was aborted".
