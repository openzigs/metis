---
issue: 2317
section: Fixed
---

- A project's monthly token budget now holds while two or more Word documents in that project are
  being ingested at once on one server. Before, each upload checked the remaining budget without
  counting the other's image descriptions in progress, so together they could describe images the
  budget no longer covered. On a deployment with several server replicas, uploads handled by
  different replicas do not see each other's descriptions in progress; each image is still checked
  against the shared budget before it is sent. An image that waited for budget room is no longer
  sent if the last image described before it used up the budget.
