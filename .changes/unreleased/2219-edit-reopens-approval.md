---
issue: 2219
section: Fixed
---

- Editing an approved requirement no longer leaves it approved. The Edit dialog now warns before
  you save (for example "Approved as v1 by Test Coordinator; saving creates v2 and reopens
  review"). After the save the requirement is awaiting review again. Restoring an older version
  over an approval does the same. The review shows "v2 differs from the approved v1" with the
  changes, and its requester can **Request re-review**, which asks the reviewers again on the
  current wording and keeps the earlier baseline. The review's reviewers and requester are
  notified once, on the first edit after the approval. Marking governing and traceability
  findings out of date is tracked separately.
