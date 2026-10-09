---
issue: 939
section: Fixed
---

- Requirements approved in the analysis approval checkpoint are now promoted as approved, so the
  requirements hub no longer asks for a second Approve on every card. The Approvals tab also gains
  an "Approve all pending" action (with a confirmation step) backed by a new
  `POST /api/projects/:projectId/analyses/:id/approvals/approve-all` endpoint, so a long list no
  longer needs one click per item.
