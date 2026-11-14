---
issue: 2493
section: Fixed
---

- Writing the string `"false"` to an on/off setting through
  `PUT /api/admin/config/:key` turns it off, instead of being stored as on.
  These settings now take only `true` / `false` (JSON or string); anything
  else is refused with `400 INVALID_VALUE`. The Configuration page sent JSON
  booleans and was not affected. **Operators:** a setting a script turned off
  with a string was left on; re-check on/off settings whose source is `db`.
