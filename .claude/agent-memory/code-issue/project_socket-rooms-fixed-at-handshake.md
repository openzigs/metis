---
name: socket-rooms-fixed-at-handshake
description: Socket.IO rooms gated on JWT claims are joined from the handshake token, so an access change applies on reconnect, not on token refresh.
metadata:
  type: project
---

`socket.data.user` is set once, at the Socket.IO handshake (`server/src/lib/socket/server.ts`). Any room joined from a claim in it, such as the `mcp:status:workspace:<id>` rooms added for #353 (PR #356), keeps that membership until the socket reconnects. A token refresh does not re-join rooms.

**Why:** the PR #356 review found a changelog that said workspace removal applied "on token refresh". For sockets it applies on reconnect.

**How to apply:** when a fix scopes a socket room by a JWT claim, say "reconnect" in the changelog and the docs. If revocation must be immediate, disconnect or leave the user's sockets on membership change. Links: [[object-acl-side-channels]].

## Re-judging one room kind does not cover the others (#1288 review, #1290)

- #1251 re-judged only `project:{id}`, `mcp:status` and `job:{id}` on member removal. The other project-data rooms stayed join-only. Both the #1288 review and #1290's own text missed `session:{id}`, which carries tool-approval prompts.
- For any access fix, grep every `socket.join`, `onRoomJoin` and `joinIfAuthorized` in `server/src/lib/socket/` and `lib/collaboration/presence.ts`. List each room kind and say how it is covered. Check that the changelog claims no more rooms than that.
- As of #1290, `rejudgeProjectDataRooms` (`project-data-rooms.ts`) covers analysis, session, connector, run, thread and presence rooms. Rooms still judged only at join are `user:{id}`, `publish:{id}`, `scheduler:status` and `task:{id}`, because their rules are role-only. A new project-data room must be added to `KINDS` in `project-data-rooms.ts`.
