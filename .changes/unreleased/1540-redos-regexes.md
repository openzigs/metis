---
issue: 1540
section: Security
---

- Several parsers could stall the server on crafted input (ReDoS, CodeQL alerts
  2 and 4 to 17). A `tasks.md` line ending in a long `satisfies AC-1 AC-1 …` clause
  no longer hangs the Spec Kit `/tasks` command, and task lines are parsed only up
  to 2,000 characters. `POST /dbs/:id/query` refuses SQL over 8,000 characters
  with a 400, the limit the AI query tool already had. SAML IdP metadata is capped
  at 256 KB and parsed as XML. A namespace prefix it uses (`md:`, `ds:`) must now
  be declared, as it is in any IdP's exported metadata. A publish batch's
  `targetBaseUrl` is capped at 2,048 characters. The embeddings sidecar reads its
  bearer token without a regex.
