---
issue: 562
section: Security
---

- Live MCP server status updates for a workspace's projects now reach only
  people who are still members of that workspace. Subscribers used to join
  workspace rooms from the list stored in their sign-in token, so after a
  workspace was deleted, or after someone was removed from it, they kept
  receiving its MCP server names, statuses and errors until the token expired.
