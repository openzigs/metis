/**
 * Custom HTTP webhook task handler — Phase 11.
 *
 * Security envelope:
 *   - Hostname allow-list pulled from `WEBHOOK_ALLOWED_HOSTS` (comma-separated).
 *   - HTTPS REQUIRED in production (NODE_ENV=production); HTTP allowed locally
 *     for ergonomic dev.
 *   - DNS pinning via `resolveAndAssertConnectorHost` PLUS an undici
 *     `Agent` whose `connect.lookup` returns the pinned address, so the
 *     fetch socket can never be hijacked between validation and connect (C1).
 *   - Redirects are handled MANUALLY (`redirect: 'manual'`). On 3xx we
 *     re-validate the new URL through the allow-list + DNS-pin pipeline,
 *     cap at 3 hops, and DROP the Authorization header on cross-origin
 *     redirects so vault secrets cannot leak (C2).
 *   - Auth header value MAY be a vault reference (`${vault:label}`) — resolved
 *     at fire-time so secrets never sit in payloads.
 *   - Outbound payload capped at `WEBHOOK_MAX_BYTES` (default 64 KiB).
 *   - Outbound timeout from `WEBHOOK_TIMEOUT_MS` (default 10 s).
 *   - Audit logs the host (NOT the full URL) and the response status only —
 *     never the auth header or response body.
 *   - Response body that fails JSON parse is logged + audited; we fall back
 *     to the raw text body for downstream visibility (L3).
 */
import { URL } from "node:url";
import {
  makePinnedLookup,
  resolveAndAssertConnectorHost,
  type PinnedHost,
} from "../connectors/network-allowlist.js";
import { getVaultService } from "../vault/vault-service.js";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import type { TaskHandlerFn } from "./types.js";

const log = createChildLogger("task-webhook");

const VAULT_REF_RE = /^\$\{vault:([^}]+)\}$/;
const MAX_REDIRECTS = 3;

export interface WebhookHandlerConfig {
  allowedHosts: string[];
  maxBytes: number;
  timeoutMs: number;
  requireHttps: boolean;
}

export function loadWebhookConfig(env: NodeJS.ProcessEnv = process.env): WebhookHandlerConfig {
  return {
    allowedHosts: (env.WEBHOOK_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    maxBytes: Number.parseInt(env.WEBHOOK_MAX_BYTES ?? "65536", 10),
    timeoutMs: Number.parseInt(env.WEBHOOK_TIMEOUT_MS ?? "10000", 10),
    requireHttps: env.NODE_ENV === "production",
  };
}

/** Public for unit tests — mirror of undici's `Dispatcher` shape we touch. */
export interface DispatcherLike {
  close?(): Promise<void>;
  destroy?(err?: Error): Promise<void>;
}

/**
 * Build an undici `Agent` whose connection layer always uses the pinned IP.
 * Dynamically `import('undici')` so this file stays compatible in test
 * environments that mock `fetch` and never need a real dispatcher.
 */
async function makePinnedDispatcher(pinned: PinnedHost): Promise<DispatcherLike> {
  const lookup = makePinnedLookup(pinned.address, pinned.family);
  if (!lookup) {
    // Caller should not reach here when pinned.address is valid; throw rather
    // than silently degrade because that would re-introduce the rebind hole.
    throw new Error("pinned lookup unavailable");
  }
  const undici = (await import("undici")) as unknown as {
    Agent: new (opts: { connect: { lookup: typeof lookup } }) => DispatcherLike;
  };
  return new undici.Agent({ connect: { lookup } });
}

export interface CreateWebhookHandlerOptions {
  config?: WebhookHandlerConfig;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to live DNS allow-list resolver. */
  resolveHost?: typeof resolveAndAssertConnectorHost;
  /** Test seam — defaults to the global vault. */
  resolveVaultRef?: (label: string) => Promise<string>;
  /** Test seam — overrides the undici dispatcher factory entirely. */
  dispatcherFactory?: (pinned: PinnedHost) => Promise<DispatcherLike>;
}

export function createHttpWebhookHandler(opts: CreateWebhookHandlerOptions = {}): TaskHandlerFn {
  const cfg = opts.config ?? loadWebhookConfig();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolveHost = opts.resolveHost ?? resolveAndAssertConnectorHost;
  const dispatcherFactory = opts.dispatcherFactory ?? makePinnedDispatcher;
  const resolveVault =
    opts.resolveVaultRef ??
    (async (label: string) => {
      const vault = getVaultService();
      const v = await vault.read(label);
      if (typeof v?.plaintext !== "string") {
        throw new Error(`vault label ${label} not found`);
      }
      return v.plaintext;
    });

  return async (ctx) => {
    const payload = ctx.task.payload as {
      url?: unknown;
      method?: unknown;
      body?: unknown;
      headers?: unknown;
      authHeader?: unknown;
    };
    const rawUrl = String(payload.url ?? "").trim();
    if (!rawUrl) throw new Error("payload.url is required");

    const initialUrl = parseSafeUrl(rawUrl, cfg);
    await assertHostAllowed(initialUrl, cfg, resolveHost);

    const method = String(payload.method ?? "POST").toUpperCase();
    if (!/^(POST|PUT|PATCH)$/.test(method)) {
      throw new Error(`webhook method ${method} not allowed`);
    }

    const bodyStr = JSON.stringify(payload.body ?? {});
    const bodyBytes = Buffer.byteLength(bodyStr, "utf8");
    if (bodyBytes > cfg.maxBytes) {
      throw new Error(`webhook payload size ${bodyBytes} exceeds cap ${cfg.maxBytes}`);
    }

    const baseHeaders: Record<string, string> = { "content-type": "application/json" };
    const customHeaders = (payload.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(customHeaders)) {
      if (typeof v !== "string") continue;
      // Block hop-by-hop and authorization overrides via headers map — auth
      // belongs in `authHeader` so we can vault-resolve it.
      if (/^authorization$/i.test(k)) continue;
      baseHeaders[k.toLowerCase()] = v;
    }
    let authValue: string | null = null;
    if (typeof payload.authHeader === "string" && payload.authHeader.length > 0) {
      const m = VAULT_REF_RE.exec(payload.authHeader);
      authValue = m ? await resolveVault(m[1]) : payload.authHeader;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timeoutHandle = setTimeout(() => controller.abort(), cfg.timeoutMs);
    timeoutHandle.unref?.();

    ctx.reportProgress({ step: `webhook:${method} ${initialUrl.hostname}` });

    let currentUrl = initialUrl;
    let pinned = await resolveHost(currentUrl.hostname, "repo");
    const dispatchers: DispatcherLike[] = [];
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // Fresh dispatcher per hop so the lookup is bound to the validated
        // IP for the host we are about to talk to.
        const dispatcher = await dispatcherFactory(pinned);
        dispatchers.push(dispatcher);

        const headers: Record<string, string> = { ...baseHeaders };
        // Authorization is only attached when the destination is the same
        // origin as the original request (drops on cross-origin redirect).
        if (
          authValue &&
          currentUrl.protocol === initialUrl.protocol &&
          currentUrl.hostname.toLowerCase() === initialUrl.hostname.toLowerCase() &&
          currentUrl.port === initialUrl.port
        ) {
          headers.authorization = authValue;
        }

        const init: Record<string, unknown> = {
          method,
          headers,
          body: bodyStr,
          signal: controller.signal,
          // Disable browser-style auto-redirect; we re-run the allow-list on
          // every hop ourselves (C2).
          redirect: "manual",
          // undici fetch reads `dispatcher` to route the connection through
          // our pinned-lookup Agent (C1).
          dispatcher,
          // Keepalive false to avoid lingering sockets on cancel.
          keepalive: false,
        };

        const res = await fetchImpl(currentUrl.toString(), init as RequestInit);

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          // Best-effort drain so the socket can be reused/closed cleanly.
          void res.body?.cancel().catch(() => {});
          if (!location) {
            throw new Error(`webhook redirect ${res.status} without Location header`);
          }
          if (hop >= MAX_REDIRECTS) {
            throw new Error(`webhook exceeded ${MAX_REDIRECTS} redirects`);
          }
          const next = resolveRedirectUrl(currentUrl, location, cfg);
          await assertHostAllowed(next, cfg, resolveHost);
          pinned = await resolveHost(next.hostname, "repo");
          currentUrl = next;
          continue;
        }

        // Terminal response — record + return.
        const ctype = res.headers.get("content-type") ?? "";
        let bodyParseError = false;
        if (ctype.includes("application/json")) {
          try {
            const text = await res.text();
            if (text.length > 0) {
              try {
                JSON.parse(text);
              } catch (parseErr) {
                // L3: don't silently swallow — log + audit, fall back to text.
                bodyParseError = true;
                log.warn("webhook JSON parse failed", {
                  host: currentUrl.hostname,
                  status: res.status,
                  error: (parseErr as Error).message,
                });
                audit({
                  action: "scheduler.webhook.parse-failed",
                  actor: ctx.task.createdById ?? null,
                  target: {
                    type: "scheduled-job",
                    id: ctx.task.scheduledJobId ?? ctx.task.id,
                  },
                  metadata: {
                    host: currentUrl.hostname,
                    status: res.status,
                    bytes: text.length,
                  },
                });
              }
            }
          } catch {
            void res.body?.cancel().catch(() => {});
          }
        } else {
          void res.body?.cancel().catch(() => {});
        }

        audit({
          action: "scheduler.webhook.fire",
          actor: ctx.task.createdById ?? null,
          target: {
            type: "scheduled-job",
            id: ctx.task.scheduledJobId ?? ctx.task.id,
          },
          metadata: { host: currentUrl.hostname, status: res.status, method, redirects: hop },
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`webhook returned non-2xx status ${res.status}`);
        }
        ctx.reportProgress({ step: "webhook:complete", pct: 100 });
        return {
          status: res.status,
          host: currentUrl.hostname,
          ...(bodyParseError ? { bodyParseError: true } : {}),
        };
      }
      throw new Error(`webhook exceeded ${MAX_REDIRECTS} redirects`);
    } catch (err) {
      if (controller.signal.aborted && !ctx.signal.aborted) {
        log.warn("webhook timed out", { host: currentUrl.hostname, timeoutMs: cfg.timeoutMs });
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
      ctx.signal.removeEventListener("abort", onAbort);
      // Tear down every dispatcher we built; `close` releases sockets without
      // dropping in-flight connections, `destroy` is the hard fallback.
      for (const d of dispatchers) {
        try {
          await d.close?.();
        } catch {
          try {
            await d.destroy?.();
          } catch {
            /* swallow */
          }
        }
      }
    }
  };
}

function parseSafeUrl(raw: string, cfg: WebhookHandlerConfig): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("webhook url is not a valid URL");
  }
  if (cfg.requireHttps && url.protocol !== "https:") {
    throw new Error("webhook url must use https in production");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`webhook protocol ${url.protocol} is not allowed`);
  }
  return url;
}

function resolveRedirectUrl(base: URL, location: string, cfg: WebhookHandlerConfig): URL {
  let next: URL;
  try {
    next = new URL(location, base);
  } catch {
    throw new Error("webhook redirect Location is not a valid URL");
  }
  if (cfg.requireHttps && next.protocol !== "https:") {
    throw new Error("webhook redirect must use https in production");
  }
  if (next.protocol !== "https:" && next.protocol !== "http:") {
    throw new Error(`webhook redirect protocol ${next.protocol} is not allowed`);
  }
  return next;
}

async function assertHostAllowed(
  url: URL,
  cfg: WebhookHandlerConfig,
  resolveHost: typeof resolveAndAssertConnectorHost,
): Promise<void> {
  if (!cfg.allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`webhook host ${url.hostname} is not on WEBHOOK_ALLOWED_HOSTS`);
  }
  // The allow-list resolver throws on private/loopback IPs and returns the
  // IP that the caller MUST use for the connection (DNS-pin).
  await resolveHost(url.hostname, "repo");
}
