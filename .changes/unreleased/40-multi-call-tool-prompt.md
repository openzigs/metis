---
issue: 40
section: Changed
---

- The code agent's tool instructions no longer say "call tools one at a time".
  They now say a reply may request several tools, as consecutive JSON objects
  or a JSON array, at most 8 per reply, which the loop has run since the fix
  for #15. This changes the cached system-prompt prefix once, by about 40
  estimated tokens per tool format, so the first analysis after upgrading
  writes a fresh prompt-cache entry.
