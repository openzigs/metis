---
issue: 13
section: Fixed
---

- GitHub repository connectors work on Node 20+ again. The DNS-pinning lookup now
  answers Node's all-addresses form (`{ all: true }`, requested whenever
  `autoSelectFamily` is on), which previously failed every connector test and ingest
  with "Invalid IP address: undefined". The pinned address is unchanged.
