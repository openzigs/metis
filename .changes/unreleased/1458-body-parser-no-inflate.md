---
issue: 1458
section: Security
---

- The API and the embeddings sidecar no longer decompress request bodies: a `gzip`,
  `deflate` or `br` encoded body is refused with 415. This closes the path to
  body-parser GHSA-27r3-jxmh-p828 (a denial of service through trailing bytes after
  a compressed body). No METIS client or integration sends one.
- body-parser 2.2.2 is covered by a waiver scoped to that copy, expiring on
  2026-10-30, until the fixed 2.4.0 clears the 7-day release-age hold.
