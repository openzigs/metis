---
issue: 1466
section: Fixed
---

- A Teams bot installed as a user-assigned managed identity now really
  authenticates as that identity. METIS spelled the type `UserAssignedMSID`,
  which the Bot Framework SDK does not recognise, so these installs silently fell
  back to app-password auth. The type is now `UserAssignedMsi`, takes a tenant id
  and no password, and installations saved with the old spelling are read as the
  new one.
