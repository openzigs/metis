---
issue: 1506
section: Fixed
---

- GitHub webhooks: a second webhook receiving the same event (the shared-secret hook and a connector's own hook on one repository, or two projects' own hooks) is no longer dropped as `DUPLICATE_DELIVERY`. The delivery-id dedup is keyed on the receiver and its signer as well as GitHub's GUID, which GitHub shares across every hook subscribed to an event.
