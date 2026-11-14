---
issue: 2493
section: Fixed
---

- Writing the string `"false"` to an on/off setting through
  `PUT /api/admin/config/:key` turns it off, instead of being stored as on.
  These settings now take the spellings the server reads from its environment
  (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`, or a JSON boolean or 0/1);
  anything else is refused with `400 INVALID_VALUE`. The Configuration page was
  not affected. **Operators:** a setting a script turned off with a string was
  left on; re-check on/off settings whose source is `db`.
