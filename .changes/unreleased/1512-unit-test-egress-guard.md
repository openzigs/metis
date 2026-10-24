---
issue: 1512
section: Fixed
---

- The server unit suite no longer reaches the network: `connector-routes.test.ts` stubs the deep-ingest `git clone`, and a new setup-file guard fails any unit test that connects to a non-loopback host or spawns `git` against a remote.
