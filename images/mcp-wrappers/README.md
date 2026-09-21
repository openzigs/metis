# MCP Wrapper Image Catalog

Epic #271 — Phase A of MCP containerisation. These images let METIS run
arbitrary MCP servers under `runtime: docker-stdio` without baking every
runtime (Python, JVM, Node) onto the platform pod.

## Images

| Wrapper          | Base image                  | Entrypoint        | When to use                                  |
| ---------------- | --------------------------- | ----------------- | -------------------------------------------- |
| `uvx-runner`     | `python:3.12-slim`          | `uvx`             | Python MCPs published as PyPI packages       |
| `jbang-runner`   | `eclipse-temurin:21-jre`    | `jbang`           | JVM MCPs distributed as JBang scripts / Maven coords (e.g. quarkiverse) |
| `node-runner`    | `node:20-alpine`            | `node`            | Self-contained Node scripts you mount/copy   |
| `npx-runner`     | `node:20-alpine`            | `npx -y`          | Node MCPs published to npm                   |
| `uvx-runner-sse`   | `uvx-runner` + `mcp-proxy`   | `mcp-proxy --sse-port 8080`         | Phase B (#272) — k8s-sse runtime               |
| `jbang-runner-sse` | `jbang-runner` + `mcp-proxy` | `mcp-proxy --sse-port 8080 -- jbang`| Phase B (#272) — k8s-sse runtime               |
| `node-runner-sse`  | `node-runner` + `mcp-proxy`  | `mcp-proxy --sse-port 8080 -- node` | Phase B (#272) — k8s-sse runtime               |
| `npx-runner-sse`   | `npx-runner` + `mcp-proxy`   | `mcp-proxy --sse-port 8080 -- npx -y`| Phase B (#272) — k8s-sse runtime              |
| `code-graph-runner-sse` | `node-runner-sse` + bundled CodeGraph MCP | `mcp-proxy --sse-port 8080 -- node /app/code-graph-mcp.js` | METIS-internal CodeGraph MCP (Epic #319) — exposes AST/derivation queries |

> **Total: 9 wrapper images.** `pnpm bootstrap:check` reports `wrapper images cached: N/9`.

Each image runs as `1000:1000` (non-root). The host network is **not**
attached — wire docker-stdio MCPs onto the user-defined bridge network
configured by `MCP_DOCKER_NETWORK` (default `metis-mcp`).

### SSE variants (Phase B, k8s-sse runtime)

The `*-sse` variants wrap each Phase A image with [`mcp-proxy`](https://www.npmjs.com/package/mcp-proxy)
to expose the MCP's stdio transport as HTTP+SSE on port 8080. METIS connects
via the in-cluster service URL when `runtime: 'k8s-sse'`. Each SSE variant
declares an `EXPOSE 8080` and a `HEALTHCHECK` against `/healthz`.

## Building

The canonical publish path is **CI on tag** (Issue #363, Epic #359).
Pushing a tag of the form `mcp-wrappers/v*` runs
`.github/workflows/wrapper-images.yml`, which builds every image
multi-arch (`linux/amd64,linux/arm64`) and pushes to
`ghcr.io/metis-mcps/<wrapper>:<VERSION>` plus `:latest`.

PRs that touch `images/mcp-wrappers/**` automatically run the same
workflow in **build-only mode** (single-arch, no push) so a Dockerfile
regression is caught before merge.

### Local iteration

For ad-hoc dev iteration on a wrapper Dockerfile, the existing
build script still works:

```sh
./images/mcp-wrappers/build.sh
```

By default images are tagged `ghcr.io/metis-mcps/<wrapper>:<VERSION>` plus
`:latest`. Override the registry with the `REGISTRY` env var:

```sh
REGISTRY=registry.internal.example.com/mcp-wrappers ./build.sh
```

To build then push (use only when CI is unavailable):

```sh
./images/mcp-wrappers/build.sh push
```

## Adding a custom wrapper

1. Create a subfolder, e.g. `images/mcp-wrappers/dotnet-runner/`.
2. Add a `Dockerfile`. Run as a non-root user (`USER 1000:1000`) and set
   the `ENTRYPOINT` to whatever transport-launching command your runtime
   provides.
3. Add the folder name to the `WRAPPERS=(…)` array in `build.sh`.
4. Publish the image to a registry and add the registry path to
   `MCP_IMAGE_ALLOWLIST` (e.g. `ghcr.io/metis-mcps/*`). Without this
   allow-list entry the registry layer rejects the registration.

## Registering an MCP server with a wrapper

```ts
await mcpApi.create({
  scope: "global",
  label: "atlassian",
  transport: "stdio",
  runtime: "docker-stdio",
  command: "ghcr.io/metis-mcps/uvx-runner:1.0", // wrapper image
  args: ["mcp-atlassian"],                       // image entrypoint args
  env: {
    CONFLUENCE_URL: "${vault:atlassian-confluence-url}",
    JIRA_API_TOKEN: "${vault:atlassian-api-token}",
  },
});
```

The provisioner translates this into:

```sh
docker run -i --rm --name metis-mcp-<id>-<short> \
  --network metis-mcp --memory 512m --cpus 1.0 \
  -e CONFLUENCE_URL -e JIRA_API_TOKEN \
  ghcr.io/metis-mcps/uvx-runner:1.0 mcp-atlassian
```

Note the `-e KEY` (no `=VALUE`) form — secrets are passed via the spawn
env map and never appear in `ps aux` on the host.

## Operations

The `metis-mcp` bridge network is **declared in `docker-compose.yml` and
`docker-compose.prod.yml` (Epic #359 / issue #361)**, so `docker compose up`
or `pnpm bootstrap:up` auto-creates it. The legacy manual step is only
needed when METIS itself is run outside compose:

```sh
# Optional — only when METIS is NOT run via docker compose.
docker network create metis-mcp
```

(Or pick a different name and set `MCP_DOCKER_NETWORK` accordingly.) Use
`pnpm bootstrap:check` to confirm the network is present.

See [docs/OPERATIONS.md](../../docs/OPERATIONS.md) for the full deployment
checklist.
