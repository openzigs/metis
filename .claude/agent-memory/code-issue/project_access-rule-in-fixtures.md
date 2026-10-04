---
name: access-rule-in-fixtures
description: socket.test.ts and the discussion-messages-cursor SQLite test encode the access rule in their prisma mock and seed data.
metadata:
  type: project
---

`server/tests/socket.test.ts` and `server/tests/discussion-messages-cursor.sqlite.test.ts` encode the access rule they exercise inside their prisma mock or seed data. When #734 moved discussions from `actorCanAccessProject` to `assertProjectAccess`, they broke at the mock/seed level, not in their assertions.

**Why:** a red fixture can look like a regression when it is only an outdated encoding of the old rule.

**How to apply:** when you change which access rule a surface uses, update those fixtures together with the rule, and keep a non-member case asserting 404.
