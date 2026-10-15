---
issue: 1129
section: Fixed
---

- On an analysis started from ticked imported items, the Approvals checkpoint lists the requirements
  that restate a ticked item apart from those "Added by the analysis", and one confirmed action
  leaves out every added one (each can be reopened). The split follows the imported items the
  analysis recorded for each requirement, so it agrees with the "Added by the analysis" badge. Added
  requirements are offered, not promoted: each is promoted only if you approve it. The ticked items'
  clarifying questions are asked first.
- Request review can be limited to chosen requirements, with "Only the N from ticked items" in one
  click, and the form says how many requirements the review covers before it is sent.
- The requirements BRD can be limited to chosen requirements of a run; the form says how many it
  will cover, and the document's title and introduction state the count.
