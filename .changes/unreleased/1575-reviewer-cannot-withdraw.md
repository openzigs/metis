---
issue: 1575
section: Fixed
---

- A reviewer is no longer offered **Withdraw review** on a review they are asked to decide, on the
  review page or on `/reviews`, and the server refuses it from them. This applies even to a
  coordinator or admin. Before, a reviewer with review-administrator rights could cancel the
  sign-off instead of approving or rejecting it. The requester can still withdraw their own
  review, and a review administrator who is not one of its reviewers still can too.
