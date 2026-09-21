# ACP — Agent Client Protocol

Epic [#163](https://github.com/openzigs/metis-private/issues/163), Issue
[#119](https://github.com/openzigs/metis-private/issues/119).

The METIS server exposes an Agent Client Protocol (ACP) endpoint so external
Copilot CLIs and other agent runtimes can list projects / skills / agents
and invoke runs without going through the browser. ACP runs over JSON-RPC
2.0 framed one-message-per-line on a WebSocket transport; a stdio bridge is
also available for local Copilot CLI integration.

## Endpoints

<!-- nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- documentation only: `wss://` is the documented production scheme; `ws://` is mentioned solely as a local-dev convenience, not application code. -->
- **WebSocket:** `wss://<server>/api/acp` (or `ws://` for local dev).
- **stdio:** `metis-acp-bridge` (planned binary; the same handlers run
  over `process.stdin`/`process.stdout`).

Both transports use the same JSON-RPC envelope and the same handler set
(`server/src/lib/acp/handlers.ts`).

## Authentication

Every connection MUST present a bearer token created via the Settings →
ACP page (`POST /api/acp/tokens`) or the equivalent REST endpoint. Tokens
are formatted as `metis_<64-hex>` so secret scanners can detect them in
config files. The plaintext is shown ONCE at creation; the database
stores `sha256(token)` only.

```
Authorization: Bearer metis_<64-hex>
```

WebSocket upgrades that lack the header — or present an unknown / revoked
/ expired token — are rejected with HTTP **401** before any frames are
sent. JSON-RPC requests on an authenticated connection that fail per-method
authorization are rejected with the documented error code
`ACP_UNAUTHORIZED` (`-32001`).

## Methods

| Method | Params | Result |
|---|---|---|
| `list-projects` | `{}` | `ProjectSummary[]` |
| `list-skills` | `{ projectId: string }` | `SkillSummary[]` |
| `list-agents` | `{ projectId: string }` | `AgentSummary[]` |
| `run-agent` | `{ projectId, agentId, prompt, stream?: boolean }` | `{ runId: string }` |
| `stream-tokens` | `{ runId: string }` | streamed `acp.token` notifications |

`stream-tokens` is implemented as a server-initiated notification stream:
once the client calls the method, the server emits zero or more
`{ "method": "acp.token", "params": { "runId", "delta" } }` notifications
followed by a single result envelope when the run completes.

## Error codes

| Code | Name | Meaning |
|---|---|---|
| `-32700` | parse error | Frame was not valid JSON |
| `-32600` | invalid request | Envelope was not a JSON-RPC 2.0 request |
| `-32601` | method not found | Method name is not implemented |
| `-32602` | invalid params | Params validation failed |
| `-32603` | `ACP_INTERNAL` | Server-side handler threw |
| `-32001` | `ACP_UNAUTHORIZED` | Missing / invalid token |
| `-32002` | `ACP_FORBIDDEN` | Authenticated but lacks scope |
| `-32004` | `ACP_NOT_FOUND` | Project / agent / run id unknown |

## `~/.copilot/mcp.json` example

```json
{
  "servers": {
    "metis": {
      "url": "wss://metis.example.com/api/acp",
      "transport": "ws",
      "headers": { "Authorization": "Bearer metis_<token>" }
    }
  }
}
```

## Lifecycle

`attachAcpServer(httpServer)` registers an `upgrade` listener on the
existing HTTP server and returns an `AcpServerHandle`. Calling
`handle.shutdown()` detaches the listener and closes every active socket
with WebSocket close code **1001** ("going away") — this is invoked from
the admin disable flow and the server shutdown path so existing sessions
terminate gracefully.
