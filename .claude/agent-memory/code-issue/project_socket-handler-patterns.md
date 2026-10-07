---
name: socket-handler-patterns
description: Socket.IO handler rules from #654/#658/#655/#682: payload?.x not destructuring, onClientEvent/onRoomJoin wrappers, room-scoped {message, room} refusals.
metadata:
  type: project
---

socket.io 4.x runs listeners in `process.nextTick` with no try/catch, so a throw in a handler kills the API process.
- **Payloads:** `({ x }) =>` crashes on a null payload (#654). Read `payload?.x` and check it is a non-empty string.
- **Registration:** register every client listener through `onClientEvent`, or `onRoomJoin` for joins, which rate-limits them (#682). Register connection listeners through `onConnection` (#658). Lint rejects a bare `.on`.
- **Async work:** a `void` promise is invisible to the wrapper. Use `runDetached`; `no-floating-promises` is on for the socket modules.
- **Join refusals:** send `auth:error { message, room }`, with one message for every cause, so ids can't be enumerated (#655, #685). The UI only toasts refusals that carry no room.
- **Rate limits:** add `code: "RATE_LIMITED"` and `retryAfterMs` only on rate-limit refusals. Followers retry those instead of dropping the room.
- **Room names:** build them with the `@metis/shared` factories (#672, #676, #686). A lint guard rejects hand-written prefixes.

**Why:** each rule closed a crash or an authorization gap found during the 2026-10-01 socket wave.

**How to apply:** when you add a socket event, follow all of these. The lint guards catch the registration and room-name rules but not the payload rule.
