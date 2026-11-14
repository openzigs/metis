/**
 * #2344 — the remote `metis-index-mcp` endpoint and its OAuth protected-resource
 * metadata, mounted at the top level (`app.ts`), outside `/api`: an MCP client
 * reaches them at the URLs the specification has it derive from the resource
 * (`/mcp`, and RFC 9728's `/.well-known/oauth-protected-resource/mcp`), not
 * through the UI's `/api` proxy. Both answer 404 until an admin turns the
 * endpoint on (`MCP_REMOTE_ENABLED`). Behaviour: `mcp/metis-index/remote/http.ts`;
 * operator guide: `docs/integrations/metis-index-mcp-remote.md`.
 */
import type { Application, RequestHandler } from "express";
import {
  createProtectedResourceMetadataHandler,
  createRemoteMcpBodyLimit,
  createRemoteMcpRouter,
  type RemoteMcpDeps,
} from "../mcp/metis-index/remote/http.js";
import {
  PROTECTED_RESOURCE_METADATA_PREFIX,
  REMOTE_MCP_PATH,
} from "../mcp/metis-index/remote/config.js";

/**
 * True for `/mcp` and anything under it, in any case (Express mounts match
 * case-insensitively) — not for a path that merely starts with the letters.
 */
export function isRemoteMcpPath(path: string): boolean {
  const p = path.toLowerCase();
  return p === REMOTE_MCP_PATH || p.startsWith(`${REMOTE_MCP_PATH}/`);
}

/** Mount BEFORE the global body parsers: bounds the endpoint's request body. */
export function mountRemoteMcpBodyLimit(app: Application, deps: RemoteMcpDeps = {}): void {
  app.use(REMOTE_MCP_PATH, createRemoteMcpBodyLimit(deps));
}

/**
 * Mount the metadata documents behind `budget` (the app-wide limiter), and the
 * endpoint behind its own budgets only (`http.ts`): the app-wide one cannot key
 * an IdP-signed token to a user, so it would pool every remote caller into one
 * bucket and, once spent, answer a valid token with a METIS 401.
 */
export function mountRemoteMcp(
  app: Application,
  budget: RequestHandler,
  deps: RemoteMcpDeps = {},
): void {
  // RFC 9728 §3.1: the path-inserted document first; the root one for clients that try it.
  app.get(
    [`${PROTECTED_RESOURCE_METADATA_PREFIX}${REMOTE_MCP_PATH}`, PROTECTED_RESOURCE_METADATA_PREFIX],
    budget,
    createProtectedResourceMetadataHandler(deps),
  );
  app.use(REMOTE_MCP_PATH, createRemoteMcpRouter(deps));
}
