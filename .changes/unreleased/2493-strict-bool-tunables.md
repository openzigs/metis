---
issue: 2493
section: Fixed
---

- Writing `"false"` to an on/off runtime setting through
  `PUT /api/admin/config/:key` now turns it off. Before, every non-empty string,
  `"false"` included, was stored as `"true"`, so the write switched the setting
  on. An on/off setting now takes `true` or `false`, as a JSON boolean or the
  string `"true"` / `"false"`; any other value, such as `"0"`, `"no"` or an
  empty string, is refused with `400 INVALID_VALUE` instead of being guessed at.
  The Configuration page's checkboxes send a JSON boolean and were not affected.
- **Operators:** if a script or API client ever turned a setting off by sending
  the string `"false"` (or `"0"`, `"no"`, `"off"`), that setting was stored as
  on. Re-check the on/off settings in the Configuration page (their `source`
  reads `db`) and set any that should be off again.
