# code-graph-runner-sse

METIS Code Discovery MCP wrapper image. **Epic [#298](https://github.com/openzigs/metis-private/issues/298)**.

Hosts five MCP tools backed by reads against the METIS `code_graphs` /
`code_symbols` / `code_edges` tables (populated by the repo-ingest tree-sitter
pass — see [#308](https://github.com/openzigs/metis-private/issues/308)).

## Tools

| Tool | Input | Output |
|---|---|---|
| `get_call_graph` | `{ file, depth?=1 }` | symbols + callees up to N hops, with `truncated:true` flag at the 1000-node cap |
| `who_calls` | `{ symbol }` (qualified name) | list of `{ filePath, line, callerSymbol }`, paginated via `nextCursor` |
| `defined_in` | `{ symbol }` | `{ filePath, line }` or `null` |
| `imports_of` | `{ file }` | `{ outbound, inbound }` import edges |
| `outline` | `{ file }` | flat ordered list of symbols in the file |

All five are **deterministic** — no LLM, no outbound network beyond the database
connection, no file-system reads.

## Build

```bash
docker build -t ghcr.io/metis-mcps/code-graph-runner-sse:1.0 \
  images/mcp-wrappers/code-graph-runner-sse/
```

## Register

```yaml
runtime: k8s-sse
command: ghcr.io/metis-mcps/code-graph-runner-sse:1.0
transport: sse  # forced by MCPRegistryService.create
egressAllowlist:
  - "host:postgres.metis.svc.cluster.local"  # the DB only
```

## Security baseline

Matches the [PR #295](https://github.com/openzigs/metis-private/pull/295) K8s-SSE
wrapper baseline:

- **Pinned by digest** at registry-push time (operator runs `build.sh` which
  emits the digest)
- **Non-root** (`USER 1000:1000`)
- **Read-only root FS** (`securityContext.readOnlyRootFilesystem: true`)
- **All capabilities dropped** (`capabilities.drop: [ALL]`)
- **Deny-all egress** NetworkPolicy except the explicitly-allowed database
  endpoint (the tools only read from the DB; no outbound HTTP)
- **Trivy** scan from [#301](https://github.com/openzigs/metis-private/issues/301)
  must pass with zero High/Critical CVEs before push

## Bundled language grammars

The image pins the following [tree-sitter](https://tree-sitter.github.io/) WASM
grammar packages via `package.json`. Versions are exact (no carets, no tildes)
and bundled into the image at build time — **no network fetch at runtime**:

| Language | npm package | Version |
|---|---|---|
| TypeScript | `tree-sitter-typescript` | 0.23.2 |
| JavaScript | `tree-sitter-javascript` | 0.23.1 |
| Python | `tree-sitter-python` | 0.23.6 |
| Go | `tree-sitter-go` | 0.23.4 |
| Java | `tree-sitter-java` | 0.23.5 |

## Required env

- `DATABASE_URL` — Postgres connection string injected by K8s as a Secret.
  The entrypoint exits with code 64 if not set.

## Optional env

- `PORT` (default `8080`) — SSE port the wrapper listens on
- `MCP_LOG_LEVEL` (default `info`)

## Image size

Target: <500 MB compressed (validated by Trivy + `docker inspect`).
