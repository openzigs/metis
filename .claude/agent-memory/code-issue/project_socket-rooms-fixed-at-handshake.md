---
name: socket-rooms-fixed-at-handshake
description: Socket.IO rooms gated on JWT claims are joined from the handshake token, so an access change applies on reconnect, not on token refresh.
metadata:
  type: project
---

`socket.data.user` is set once, at the Socket.IO handshake (`server/src/lib/socket/server.ts`). Any room joined from a claim in it, such as the `mcp:status:workspace:<id>` rooms added for #353 (PR #356), keeps that membership until the socket reconnects. A token refresh does not re-join rooms.

**Why:** the PR #356 review found a changelog that said workspace removal applied "on token refresh". For sockets it applies on reconnect.

**How to apply:** when a fix scopes a socket room by a JWT claim, say "reconnect" in the changelog and the docs. If revocation must be immediate, disconnect or leave the user's sockets on membership change. Links: [[object-acl-side-channels]].
