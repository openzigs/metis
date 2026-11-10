---
issue: 2167
section: Security
---

- Approving or rejecting a single card on the Approvals tab is now rate limited like the
  checkpoint's other actions: 300 reviews per user every 15 minutes by default
  (`ANALYSIS_APPROVAL_REVIEW_RATE_LIMIT_MAX`), well above working through a long list by hand.
  Before this, only the app-wide limit applied to it. **Approve all** still approves a longer
  list in one request.
