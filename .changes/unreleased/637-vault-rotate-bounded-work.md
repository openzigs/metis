---
issue: 637
section: Security
---

- A foreign-owner vault rotate attempt no longer reloads and rehashes every
  binding of the secret: the whole-set digest, total, counts and capped listing
  are cached against a binding epoch that database triggers bump on every
  binding write, so repeated refusals and confirms of an unchanged set read no
  binding rows. The digest still changes on any added, removed or re-pointed
  binding.
