---
issue: 1466
section: Fixed
---

- Teams bots installed as a user-assigned managed identity (now `UserAssignedMsi`;
  `UserAssignedMSID` was silently ignored) really authenticate as it. The operator
  must list the identity in `TEAMS_MSI_CLIENT_IDS`, optionally bound to a workspace,
  and sends go only to Bot Framework / Teams hosts. Installing a bot revokes the old one.
- Upgrade note: installs saved as `UserAssignedMSID` really signed in as MultiTenant
  with their password. They STOP working on upgrade (unless their id is allowlisted)
  and show "Needs reinstall"; reconnect them, as MultiTenant if they use a secret.
