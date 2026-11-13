---
issue: 2453
section: Security
---

- Only an admin can change a project's **Allow self-approval** setting. A coordinator, who is
  bound by maker-checker, can no longer switch it on for their own project and then approve their
  own requirement: the Approval gate card shows them the setting read-only, and the server refuses
  the change (403) and records the attempt in the audit log. The messages that refuse a
  self-approval now say an admin can allow it. **After upgrading**, an admin should look in the
  audit log for `project.selfApproval.update` entries made by a coordinator: the upgrade leaves a
  setting a coordinator already switched on as it is, so turn it off wherever it is not wanted.
