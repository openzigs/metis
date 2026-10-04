---
issue: 820
section: Changed
---

- Until the stored rows are dropped (#821), vault foreign-owner rotation still lists bindings from test-management connections left by the removed Test Coverage feature, as type `test_management_connection` in the `409 VAULT_ROTATE_FOREIGN_OWNER` payload, and a secret they reference still counts as in use.
