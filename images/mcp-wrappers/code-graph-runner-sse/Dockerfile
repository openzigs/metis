# syntax=docker/dockerfile:1.7
# Epic #298 / Issue #307 — code-graph-runner-sse wrapper image.
#
# Hosts a Node MCP server that exposes the five Code Discovery query tools
# (`get_call_graph`, `who_calls`, `defined_in`, `imports_of`, `outline`) over
# the K8s SSE transport (mcp-proxy on :8080).
#
# Bundles `web-tree-sitter` and pinned WASM grammar bundles for TypeScript,
# JavaScript, Python, Go, and Java so the image is deterministic — no network
# fetch at runtime. The grammar bundles are pinned via npm in package.json;
# the build asserts the resolved versions match the documented digests.
#
# Tools read from the METIS Postgres database via a Prisma client constructed
# at startup from the injected `DATABASE_URL`. Egress is restricted to the
# database endpoint by the per-MCP NetworkPolicy (see PR #295 K8s-SSE pattern).
#
# Security baseline (matches PR #295 K8s-SSE wrappers):
#   - Multi-stage build, distroless-style runtime layer
#   - Runs as non-root UID 1000:1000
#   - Read-only root filesystem (entrypoint targets writable /tmp only)
#   - All Linux capabilities dropped at the K8s level
#   - Pinned by digest at registry-push time (build.sh enforces)
#   - Trivy scan from #301 must pass (zero High/Critical CVEs) before push
#
# Register with:
#   runtime: 'k8s-sse'
#   command: 'ghcr.io/metis-mcps/code-graph-runner-sse:1.0'
#   transport: 'sse' (forced by MCPRegistryService.create)

# Use a current Alpine-backed Node image so Trivy picks up fixed OpenSSL/npm packages.
FROM node:22-alpine3.23 AS builder
WORKDIR /build

# Install build deps for any optional native modules (we don't ship any but
# Prisma's engine prebuilds may pull libssl).
RUN apk add --no-cache --no-progress libstdc++ openssl ca-certificates

COPY package.json package-lock.json* ./
# Deterministic install when a lockfile is present. Local bootstrap fallbacks
# must also survive a freshly-added wrapper whose lockfile has not landed yet.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts; \
    else \
      npm install --omit=dev --ignore-scripts; \
    fi

COPY server.ts ./
COPY tsconfig.json ./
COPY queries/ ./queries/
COPY prisma/schema.prisma ./prisma/schema.prisma

RUN npx prisma generate --schema ./prisma/schema.prisma

# Compile TypeScript to JavaScript inside the builder so the runtime layer
# does not need a compiler. (Single-pass tsc; emits to /build/dist.)
RUN npm exec --yes --package typescript@5.6.3 -- tsc -p tsconfig.json \
  || (echo "tsc failed - see above" && exit 1)

# ---------------------------------------------------------------------------
# Runtime layer — minimal Alpine, no compiler, no shell beyond ash.
# ---------------------------------------------------------------------------
FROM node:22-alpine3.23 AS runtime

LABEL org.opencontainers.image.title="code-graph-runner-sse"
LABEL org.opencontainers.image.description="METIS Code Discovery MCP server (Epic #298)"
LABEL org.opencontainers.image.source="https://github.com/openzigs/metis"
LABEL org.opencontainers.image.licenses="MIT"

# wget for HEALTHCHECK; mcp-proxy installed below; no ssh/curl/etc.
RUN apk add --no-cache --no-progress wget ca-certificates \
 && npm install -g npm@latest \
 && npm install -g --omit=dev --ignore-scripts mcp-proxy@2.10.0 \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/* /var/cache/apk/*

WORKDIR /srv
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./package.json
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && chown -R 1000:1000 /srv

# Non-root runtime user.
USER 1000:1000

# Read-only root FS friendly: only /tmp is writable.
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
