---
issue: 749
section: Security
---

- Publishing to GitHub no longer risks reusing another project's credential. The
  cached GitHub client was matched on a token's length and first and last two
  characters, which for classic personal access tokens collided about once in
  3,844, so a publish could go out under the wrong project's token. Clients are
  now keyed on a SHA-256 of the full token and the pinned address, and the cache
  is bounded to 100 entries.
