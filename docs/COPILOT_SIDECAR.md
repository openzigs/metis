# Copilot Native Sidecar (`copilot-svc`) — Issue #180

The optional `metis-copilot` sidecar externalises `@github/copilot-sdk` so
the main `metis-server` image can stay minimal/Alpine while the SDK runs in
its own glibc Node container. The sidecar is **opt-in** — when
`COPILOT_NATIVE_MODE` is unset (or anything other than `sidecar`), the
server keeps loading the SDK in-process, exactly as today.

## When to enable it

Turn the sidecar on if any of these apply:

- Your registry policy or platform requires the main runtime image to ship
  without `@github/copilot-sdk` (e.g. CVE blast-radius reduction, Alpine-only
  runtime base).
- You want to redeploy the SDK on a different cadence than the main server.
- You need to scale the SDK horizontally without scaling the rest of the
  server.

If none of those apply, leave `COPILOT_NATIVE_MODE` unset — the in-process
path is simpler, has fewer moving parts, and skips one network hop per
session call.

## Activation

```bash
# Generate a shared secret (32+ bytes is fine).
export COPILOT_NATIVE_TOKEN="$(openssl rand -hex 32)"
export COPILOT_NATIVE_MODE=sidecar

# Bring the stack up with the `copilot-native` profile so compose schedules
# the sidecar.
docker compose --profile copilot-native up -d
```

The main server reads `COPILOT_NATIVE_BASE_URL` (defaults to
`http://copilot:5060`) and `COPILOT_NATIVE_TOKEN`. The sidecar listens on
`COPILOT_NATIVE_HOST:COPILOT_NATIVE_PORT` (default `0.0.0.0:5060`) and
fails closed with HTTP 503 when its own `COPILOT_NATIVE_TOKEN` is unset.

## HTTP surface

All endpoints except `GET /healthz` require an
`Authorization: Bearer <COPILOT_NATIVE_TOKEN>` header. The token is
validated via `crypto.timingSafeEqual` to avoid early-exit timing attacks.

| Method   | Path                              | Purpose                                                   |
|----------|-----------------------------------|-----------------------------------------------------------|
| `GET`    | `/healthz`                        | Unauthenticated liveness probe.                           |
| `GET`    | `/auth/status`                    | `{ isAuthenticated, authType }`.                          |
| `GET`    | `/models`                         | Available models from the SDK.                            |
| `POST`   | `/sessions`                       | Create a new SDK session, returns `{ sessionId }`.        |
| `POST`   | `/sessions/:id/send`              | Stream a turn as `text/event-stream`.                     |
| `POST`   | `/sessions/:id/send-and-wait`     | Synchronous variant; returns the final response as JSON.  |
| `DELETE` | `/sessions/:id`                   | Best-effort destroy / disconnect.                         |

### `POST /sessions` — `permissionMode`

The session-create body accepts `permissionMode: "auto-approve" | "deny"`.
The sidecar refuses `"interactive"` with HTTP 400 +
`{ "error": "interactive_permission_not_supported" }` because there is no
RPC channel back to the main server for permission prompts in the v1
sidecar. If you need interactive approval today, run the SDK in-process
(`COPILOT_NATIVE_MODE=` unset).

### SSE event names

The streaming `/sessions/:id/send` endpoint forwards these SDK events:

- `assistant.message`
- `assistant.message_delta`
- `session.idle`     — terminating event for the turn
- `usage`            — token + cost telemetry frames
- `session.complete` — fallback emitted when `send()` resolves with no
  `session.idle`
- `error`            — surfaced when the SDK rejects mid-send

## Session lifecycle

Sessions live in an in-memory `SessionRegistry` keyed by `sessionId`. Each
session has a sliding-window TTL (default 30 minutes,
`COPILOT_NATIVE_SESSION_TTL_MS`); every call resets the timer. Sessions
older than the TTL are destroyed automatically. The sidecar is **stateless
beyond this map** — restarting the container drops all sessions and the
main server creates new ones on the next call.

## Security posture

- Bearer token via `crypto.timingSafeEqual`.
- Fails closed (`503`) when the token is unset.
- 8 MB JSON body limit.
- `x-powered-by` header disabled.
- No `dotenv` import — the operator owns env injection.
- `~/.metis/auth.json` lives inside the sidecar's `/data` volume; the main
  server does **not** mount that path under sidecar mode. Token storage is
  isolated to the sidecar container.
- **No process writes that file.** The `/auth/device/start` and
  `/auth/device/wait` routes were removed in #1348 — `CopilotClient` has never
  exposed `startDeviceAuth` or `waitForAuth` (measured on 0.2.2 and 0.3.0), so
  both could only ever answer `501 not_supported`. The file is read if an
  operator supplies it; otherwise auth comes from `GITHUB_TOKEN` or the host's
  `~/.config/github-copilot/apps.json`.

## Operational notes

- The sidecar image is exempt from the 350 MB image-size budget; track it
  separately.
- Compose schedules it only with `--profile copilot-native`. Without the
  profile the build never runs and the network never exposes port 5060.
- Health is verified by the in-container `node -e "require('http').get(...)"`
  HEALTHCHECK so no extra binaries are required.
- The remote client (`server/src/lib/ai/remote-copilot-client.ts`) reuses
  the same retry-and-fail-loud pattern as `embeddings-client.ts` so 401/503
  surface as configuration drift, not transient flakiness.
