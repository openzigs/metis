---
name: request-body-parsers-and-embeddings-svc
description: body-parser has two consumers (server/ and server/embeddings-svc), so a server-wide sweep must cover both; typing express.json wrappers; sending raw compressed bytes in tests (#1461 and its review).
metadata:
  type: project
---

From #1461 and its review (2026-10-23).

- **Two consumers.** All `server/` request parsers go through
  `server/src/middleware/body-parsers.ts` (inflate forced false). `server/embeddings-svc` is a
  separate Express app resolving the same express/body-parser copy, with its own
  `express.json()` mounted before auth. Any "every X in the server" sweep (parsers, rate
  limits, auth) must also scan `server/embeddings-svc/src`. List consumers with
  `git grep -l 'from "express"'` repo-wide.
- **Typing.** `express.json()` returns body-parser's `NextHandleFunction`, not
  `RequestHandler`; type wrappers as `ReturnType<typeof express.json>`.
- **Raw bytes in tests.** supertest/superagent JSON-serialises a `Buffer` sent as
  `application/json`. Add `.serialize((b) => b)` to send raw compressed bytes, or inflate-path
  tests get "incorrect header check" and a 500.
- **embeddings-svc tests** use `invoke()` (`server/embeddings-svc/tests/helpers/invoke-app.ts`,
  `raw` option for compressed bodies), never supertest (#692).

Related: [[dependency-audit-flips-on-new-advisories]], [[preauth-limiters-keyed-on-req-ip]].
