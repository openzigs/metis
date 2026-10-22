---
name: socket-session-lifecycle
description: How a Socket.IO connection ends with its sign-in session (#1408, #1414/#1418) — server close points, cookie-expiry reconnect refusals, the replica relay, and the UI client's Manager, AuthProvider and test-mock traps.
metadata:
  type: project
---

From #1408 and #1418 (which resolved #1414) and their reviews (2026-10-22). Checked on
`main` at 704868d0.

**Server side.**
- Before #1414 a live connection outlived its JWT: `exp` was checked only at the
  handshake, and revalidation checked liveness and role only. Every path that ends a
  session must close the socket. "The cookie is already invalid" is not a reason a socket
  is harmless. Since #1418 `server/src/lib/socket/session-disconnect.ts` binds each socket
  to the token's `sid` and closes it on logout (that session only), at token expiry and on
  revocation.
- The `metis.at` access cookie's max-age equals the access-token lifetime. So a server
  close at token expiry gets an `UNAUTHORIZED` reconnect refusal (no cookie), not
  `TOKEN_EXPIRED`. Client recovery must handle both.
- Replica-to-replica revocations go through `revocation-relay.ts`: `io.on` of server-side
  events, clustered servers only, with string arity checked. A client cannot emit them. A
  relayed revoke-all cutoff is clamped to the receiving replica's clock.
- Deleting per-socket timer and listener cleanup on disconnect left a real-socket suite
  green (#1418 review). Whenever you add a per-socket timer, assert a timer count or spy on
  `clearTimeout`.

**UI client (`ui/src/lib/socket-client.ts`, `ui/src/lib/auth-context.tsx`).**
- Every UI path that ends a session must call `closeSocket()`: logout AND a refresh
  failure (#1408 review).
- socket.io-client 4.8.4's `lookup()` builds a fresh, uncached Manager whenever the cached
  one already holds that namespace (`cache[id].nsps`), and `destroy()` never removes it. So
  a closed socket's Manager is never reused for the same URL and namespace.
- An AuthProvider effect that tears down module state while `user` is null also runs on
  first mount (child effects run first). That is safe only because `AppShell` renders no
  children until signed in. Re-check it before moving a socket consumer outside `AppShell`.
- About 58 ui test files `vi.mock("@/lib/socket-client", …)`. When AuthProvider imports
  another export from it, they break (20 files needed `closeSocket: vi.fn()` on #1408).
  Grep `vi.mock("@/lib/socket-client"` under `ui/tests` whenever you add an import.

Related: [[socket-handler-patterns]], [[membership-access-widening-checklist]],
[[vi-fn-returned-promise-hides-unhandled-rejection]].
