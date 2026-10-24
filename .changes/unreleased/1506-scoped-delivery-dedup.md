---
issue: 1506
section: Fixed
---

- GitHub webhooks: a second webhook receiving the same event (the shared-secret hook and a connector's own hook on one repository, or two projects' own hooks) is no longer dropped as `DUPLICATE_DELIVERY`. The delivery-id dedup is keyed on the receiver and its signer as well as GitHub's GUID, which GitHub shares across every hook subscribed to an event.
- PR reviews: a project with its own webhook secret on a repository never also takes shared-secret deliveries through another of its connections, and one project's queued review of a pull request is no longer dropped as superseded by another project's review of the same pull request.
