---
issue: 659
section: Security
---

- On a multi-replica Postgres deployment, every replica now re-checks the live
  connections it holds once a minute. A user deprovisioned, given a new role, or removed
  from a workspace on one replica whose message to the others failed to send (its
  database pool timing out, say, while the other replicas stayed connected) is now
  disconnected, reconnected with the new role, or taken out of that workspace's MCP status
  updates on every other replica within about a minute. Before, those replicas kept that
  access until the connection next reconnected.
- A failed database lookup during that periodic check keeps the connection and retries on
  the next check, so a brief database blip no longer disconnects everyone at once. Set
  `METIS_SOCKET_REVALIDATE_INTERVAL_MS` (minimum 10 s) to change the one-minute interval.
