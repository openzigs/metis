/**
 * #2344 — the admin settings of the remote `metis-index-mcp` endpoint.
 *
 * Off by default: `MCP_REMOTE_ENABLED` is an explicit admin setting
 * (`/api/admin/config`), and every other key is read only once it is on. The
 * settings are read on every request, so turning the endpoint off applies to
 * the next request without a restart.
 *
 * An enabled endpoint whose settings do not hold together (a URL that does not
 * parse, plain HTTP to a host other than this machine, a resource that is not
 * served at {@link REMOTE_MCP_PATH}) is `misconfigured`: it answers 503 and
 * serves no metadata, rather than a half-checked authorization surface.
 */
import { getConfigService, type ConfigService } from "../../../lib/config/index.js";
import { normaliseOrigin, parseCorsOrigins } from "../../../lib/config/cors-origins.js";

/** Where the endpoint is mounted (`app.ts`). The configured resource URL must name this path. */
export const REMOTE_MCP_PATH = "/mcp";
/** RFC 9728 §3: the well-known prefix, with the resource's path appended. */
export const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

export const DEFAULT_REMOTE_SCOPE = "mcp:read";
export const DEFAULT_REMOTE_RATE_LIMIT_PER_MINUTE = 60;

/** The registry keys this module reads (`lib/config/key-registry.ts`). */
export const REMOTE_KEYS = {
  ENABLED: "MCP_REMOTE_ENABLED",
  RESOURCE_URL: "MCP_REMOTE_RESOURCE_URL",
  ISSUER: "MCP_REMOTE_ISSUER",
  JWKS_URL: "MCP_REMOTE_JWKS_URL",
  SCOPE: "MCP_REMOTE_SCOPE",
  ALLOWED_ORIGINS: "MCP_REMOTE_ALLOWED_ORIGINS",
  RATE_LIMIT: "MCP_REMOTE_RATE_LIMIT_PER_MINUTE",
} as const;

export interface RemoteMcpSettings {
  /** The RFC 8707 resource identifier: a token's `aud` must contain it. No trailing slash. */
  resource: string;
  /** Absolute URL of this resource's RFC 9728 metadata document. */
  metadataUrl: string;
  /** The authorization server's issuer: a token's `iss` must equal it. */
  issuer: string;
  /** Where the authorization server publishes its signing keys. */
  jwksUrl: string;
  /** The one scope every tool call needs (read-only). */
  scope: string;
  /** Browser origins allowed to call the endpoint; a request with any other `Origin` is refused. */
  allowedOrigins: ReadonlySet<string>;
  /** Plain HTTP is accepted only for a resource on this machine (local development). */
  requireTls: boolean;
  rateLimitPerMinute: number;
}

export type RemoteMcpConfig =
  | { state: "disabled" }
  | { state: "misconfigured"; problem: string }
  | { state: "enabled"; settings: RemoteMcpSettings };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Parse an http(s) URL; plain HTTP only to this machine. Throws with the key's name. */
function secureUrl(key: string, raw: string | undefined): URL {
  if (!raw) throw new Error(`${key} is not set`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key} is not a URL`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new Error(`${key} must be https (plain http only for localhost)`);
}

function withoutTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/** Read and check the remote endpoint's settings. Never throws. */
export function readRemoteMcpConfig(
  svc: Pick<ConfigService, "get" | "getBool" | "getNumber"> = getConfigService(),
): RemoteMcpConfig {
  if (!svc.getBool(REMOTE_KEYS.ENABLED, false)) return { state: "disabled" };
  try {
    const resourceUrl = secureUrl(REMOTE_KEYS.RESOURCE_URL, svc.get(REMOTE_KEYS.RESOURCE_URL));
    if (resourceUrl.search || resourceUrl.hash) {
      throw new Error(`${REMOTE_KEYS.RESOURCE_URL} must not carry a query or fragment`);
    }
    const path = withoutTrailingSlash(resourceUrl.pathname);
    if (path !== REMOTE_MCP_PATH) {
      throw new Error(`${REMOTE_KEYS.RESOURCE_URL} must end in ${REMOTE_MCP_PATH}`);
    }
    const resource = `${resourceUrl.origin}${path}`;
    // `iss` is compared as a string: keep the configured value exactly as written.
    const issuer = svc.get(REMOTE_KEYS.ISSUER) ?? "";
    secureUrl(REMOTE_KEYS.ISSUER, issuer);
    const jwksUrl = secureUrl(REMOTE_KEYS.JWKS_URL, svc.get(REMOTE_KEYS.JWKS_URL)).toString();
    const scope = (svc.get(REMOTE_KEYS.SCOPE) ?? DEFAULT_REMOTE_SCOPE).trim();
    if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)) {
      throw new Error(`${REMOTE_KEYS.SCOPE} must be one scope token`);
    }
    const allowedOrigins = new Set(
      parseCorsOrigins(svc.get(REMOTE_KEYS.ALLOWED_ORIGINS) ?? "")
        .map((o) => normaliseOrigin(o))
        .filter((o): o is string => o !== null),
    );
    const rateLimitPerMinute = svc.getNumber(
      REMOTE_KEYS.RATE_LIMIT,
      DEFAULT_REMOTE_RATE_LIMIT_PER_MINUTE,
    );
    return {
      state: "enabled",
      settings: {
        resource,
        metadataUrl: `${resourceUrl.origin}${PROTECTED_RESOURCE_METADATA_PREFIX}${path}`,
        issuer,
        jwksUrl,
        scope,
        allowedOrigins,
        requireTls: resourceUrl.protocol === "https:",
        rateLimitPerMinute: rateLimitPerMinute > 0 ? rateLimitPerMinute : 1,
      },
    };
  } catch (err) {
    return { state: "misconfigured", problem: (err as Error).message };
  }
}
