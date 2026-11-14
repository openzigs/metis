/**
 * #2344 — `metis-index-mcp` over Streamable HTTP, with METIS as an OAuth 2.1
 * resource server (MCP authorization, revision 2025-11-25).
 *
 * The same eight `metis_*` tools as the stdio server (#2331), through the same
 * `createIndexMcpServer`, so every call takes the dispatcher's path: the user
 * resolved again, project access, per-document ACLs, redaction, the audit log.
 * Only how the caller is identified differs.
 *
 * Every request to `/mcp`, in order:
 *
 *   1. off (the default) → 404; settings that do not hold together → 503;
 *   2. TLS: a resource configured as `https` refuses a plain-HTTP request (403).
 *      Plain HTTP is configurable only for a localhost resource;
 *   3. `Origin`: present and not an allowed origin → 403 (DNS rebinding);
 *   4. bearer token: none → 401 with `WWW-Authenticate` naming the RFC 9728
 *      metadata; one that fails signature, issuer, expiry or audience → 401
 *      `invalid_token`. A METIS API token or any static secret is not a JWT
 *      from the configured issuer, so it fails here;
 *   5. the subject maps to exactly one active METIS user (`identity.ts`), or 401;
 *   6. scope: without the configured read scope → 403 `insufficient_scope`,
 *      naming the scope;
 *   7. that user's rate limit (per minute) → 429;
 *   8. POST only (stateless: no GET stream, no DELETE) → otherwise 405. The
 *      SDK refuses a body that is not JSON (415) on its Content-Type, unread.
 *
 * Stateless: a fresh server and transport per request, no `Mcp-Session-Id`,
 * so no session id is ever what authorizes a request; the token is checked on
 * every request.
 *
 * No token passthrough: the inbound token is read by the verifier and dropped.
 * It is not put on `req`, not given to the SDK transport (`req.auth` is never
 * set), not handed to the dispatcher, and nothing here makes an outbound call
 * with it. The only outbound call is the JWKS fetch, which carries no credential.
 */
import { Router, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { audit as defaultAudit } from "../../../lib/audit/audit-service.js";
import { createChildLogger } from "../../../lib/logger.js";
import { normaliseOrigin } from "../../../lib/config/cors-origins.js";
import { jsonBodyParser } from "../../../middleware/body-parsers.js";
import { clusterRateLimitStore } from "../../../middleware/cluster-rate-limit-store.js";
import { AUDIT_DENIED_ACTION } from "../dispatcher.js";
import { createIndexMcpServer } from "../server.js";
import { readRemoteMcpConfig, type RemoteMcpConfig, type RemoteMcpSettings } from "./config.js";
import { mapAccessTokenToUser, mappedUserVerifier, type UserMapping } from "./identity.js";
import {
  createAccessTokenVerifier,
  InvalidAccessTokenError,
  type VerifiedAccessToken,
} from "./token-verifier.js";

const log = createChildLogger("mcp-remote");

/** The largest JSON-RPC request body accepted. Tool inputs are bounded far below this. */
export const MAX_REMOTE_BODY_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 60_000;

type AuditFn = typeof defaultAudit;

export interface RemoteMcpDeps {
  readConfig?: () => RemoteMcpConfig;
  verifyToken?: (token: string, settings: RemoteMcpSettings) => Promise<VerifiedAccessToken>;
  mapUser?: (token: VerifiedAccessToken) => Promise<UserMapping>;
  audit?: AuditFn;
  /** Builds the MCP server for one request (test seam). */
  createServer?: typeof createIndexMcpServer;
}

/** What the auth steps leave for the handler: the mapped user, never the token. */
interface RemoteLocals {
  remoteMcp?: { settings: RemoteMcpSettings; userId?: string };
}

// Structural: express-rate-limit's callbacks may be typed against another @types/express.
function locals(res: { locals: object }): RemoteLocals {
  return res.locals as RemoteLocals;
}

function quote(v: string): string {
  return `"${v.replace(/["\\]/g, "")}"`;
}

/**
 * The `WWW-Authenticate` challenge (RFC 6750 §3, RFC 9728 §5.1). With no
 * credential presented, no `error` (RFC 6750 §3.1).
 */
export function bearerChallenge(
  settings: RemoteMcpSettings,
  error?: { code: "invalid_token" | "insufficient_scope"; description: string },
): string {
  const parts = [
    ...(error
      ? [`error=${quote(error.code)}`, `error_description=${quote(error.description)}`]
      : []),
    `scope=${quote(settings.scope)}`,
    `resource_metadata=${quote(settings.metadataUrl)}`,
  ];
  return `Bearer ${parts.join(", ")}`;
}

/** The RFC 9728 protected-resource metadata document. */
export function protectedResourceMetadata(settings: RemoteMcpSettings): Record<string, unknown> {
  return {
    resource: settings.resource,
    authorization_servers: [settings.issuer],
    scopes_supported: [settings.scope],
    bearer_methods_supported: ["header"],
    resource_name: "METIS index (metis-index-mcp)",
  };
}

function readBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header);
  return m ? m[1]! : "";
}

/**
 * No passthrough: the SDK hands every tool handler the request's headers
 * (`extra.requestInfo`, built from `rawHeaders`); with the token gone from both
 * header views, nothing past authentication can read or forward it.
 */
export function dropAuthorization(req: Request): void {
  delete req.headers.authorization;
  const raw = req.rawHeaders;
  const kept: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() !== "authorization") kept.push(raw[i]!, raw[i + 1]!);
  }
  raw.splice(0, raw.length, ...kept);
}

/**
 * Mounted at `/mcp` BEFORE the app's global body parsers (`app.ts`), so the
 * endpoint's body is bounded at {@link MAX_REMOTE_BODY_BYTES} rather than the
 * global 10 MiB. Only while the endpoint is on: off, `/mcp` is any unknown path.
 */
export function createRemoteMcpBodyLimit(
  deps: Pick<RemoteMcpDeps, "readConfig"> = {},
): RequestHandler {
  const readConfig = deps.readConfig ?? (() => readRemoteMcpConfig());
  const parse = jsonBodyParser({ limit: MAX_REMOTE_BODY_BYTES, type: "application/json" });
  const handler: RequestHandler = (req, res, next) => {
    if (readConfig().state !== "enabled") return next();
    // Only JSON-RPC is accepted on POST. Answered here, before the global
    // urlencoded parser (10 MiB) reads a form body ahead of authentication.
    if (req.method === "POST" && !req.is("application/json")) {
      res.status(415).json({ error: "unsupported_media_type" });
      return;
    }
    // body-parser refuses a declared length over the limit before reading, and
    // counts a chunked body as it streams; either way 413, the body drained.
    (parse as unknown as RequestHandler)(req, res, next);
  };
  return handler;
}

/** `GET /.well-known/oauth-protected-resource[/mcp]` — 404 while the endpoint is off. */
export function createProtectedResourceMetadataHandler(
  deps: Pick<RemoteMcpDeps, "readConfig"> = {},
): RequestHandler {
  const readConfig = deps.readConfig ?? (() => readRemoteMcpConfig());
  return (_req, res) => {
    const cfg = readConfig();
    if (cfg.state !== "enabled") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.set("Cache-Control", "public, max-age=300");
    res.json(protectedResourceMetadata(cfg.settings));
  };
}

export function createRemoteMcpRouter(deps: RemoteMcpDeps = {}): Router {
  const readConfig = deps.readConfig ?? (() => readRemoteMcpConfig());
  const verifier = deps.verifyToken ?? createAccessTokenVerifier().verify;
  const mapUser = deps.mapUser ?? mapAccessTokenToUser;
  const audit = deps.audit ?? defaultAudit;
  const createServer = deps.createServer ?? createIndexMcpServer;

  const router = Router();

  const denied = (reason: string, actorId: string | null) =>
    audit({
      actor: actorId ? { id: actorId } : null,
      action: AUDIT_DENIED_ACTION,
      target: { type: "mcp_endpoint", id: "remote" },
      metadata: { transport: "remote", reason },
    });

  // 1. On, and configured.
  router.use((_req, res, next) => {
    const cfg = readConfig();
    if (cfg.state === "disabled") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (cfg.state === "misconfigured") {
      log.error(`remote MCP endpoint is enabled but misconfigured: ${cfg.problem}`);
      res.status(503).json({ error: "temporarily_unavailable" });
      return;
    }
    locals(res).remoteMcp = { settings: cfg.settings };
    next();
  });

  // 2. TLS, and 3. Origin.
  router.use((req, res, next) => {
    const { settings } = locals(res).remoteMcp!;
    if (settings.requireTls && !req.secure) {
      res.status(403).json({ error: "tls_required" });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const normal = normaliseOrigin(origin);
      if (!normal || !settings.allowedOrigins.has(normal)) {
        log.warn("remote MCP request refused: origin not allowed");
        res.status(403).json({ error: "origin_not_allowed" });
        return;
      }
    }
    next();
  });

  // 4–6. Bearer token, user, scope.
  router.use(async (req, res, next) => {
    const state = locals(res).remoteMcp!;
    const { settings } = state;
    const token = readBearer(req.headers.authorization);
    if (token === null) {
      res.set("WWW-Authenticate", bearerChallenge(settings));
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const invalid = (description: string) => {
      res.set(
        "WWW-Authenticate",
        bearerChallenge(settings, { code: "invalid_token", description }),
      );
      res.status(401).json({ error: "invalid_token", error_description: description });
    };
    if (token === "") return invalid("The Authorization header is not a bearer token.");
    let verified: VerifiedAccessToken;
    try {
      verified = await verifier(token, settings);
    } catch (err) {
      if (err instanceof InvalidAccessTokenError) {
        log.warn(`remote MCP token refused (${err.reason})`);
        return invalid("The access token is not valid for this resource.");
      }
      return next(err);
    }
    let mapping: UserMapping;
    try {
      mapping = await mapUser(verified);
    } catch (err) {
      return next(err);
    }
    if (!mapping.ok) {
      denied(mapping.reason, null);
      log.warn(`remote MCP token refused (${mapping.reason} subject)`);
      return invalid("The access token's subject is not an active METIS user.");
    }
    if (!verified.scopes.includes(settings.scope)) {
      denied("scope", mapping.userId);
      const description = `The access token needs the ${settings.scope} scope.`;
      res.set(
        "WWW-Authenticate",
        bearerChallenge(settings, { code: "insufficient_scope", description }),
      );
      res.status(403).json({ error: "insufficient_scope", error_description: description });
      return;
    }
    state.userId = mapping.userId;
    dropAuthorization(req);
    next();
  });

  // 7. Per-user rate limit. Built once, here: express-rate-limit refuses one built in a handler.
  const limiter = rateLimit({
    store: clusterRateLimitStore("mcp-remote"),
    windowMs: RATE_WINDOW_MS,
    limit: (_req, res) => locals(res).remoteMcp!.settings.rateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (_req, res) => `mcp-remote:user:${locals(res).remoteMcp!.userId}`,
    handler: (_req, res) => {
      res.status(429).json({ error: "rate_limited" });
    },
  });
  router.use(limiter as unknown as RequestHandler);

  // 8. The MCP exchange.
  router.post("/", async (req: Request, res: Response, next) => {
    const { userId } = locals(res).remoteMcp!;
    const server = createServer({
      credential: "oauth",
      verify: mappedUserVerifier(userId!),
      audit: (entry) => audit({ ...entry, metadata: { ...entry.metadata, transport: "remote" } }),
      log: (line) => log.warn(line),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  });
  router.all("/", (_req, res) => {
    res.set("Allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
  });

  return router;
}
