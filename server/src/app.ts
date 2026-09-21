/**
 * Express 5 application factory.
 *
 * Order of operations matters:
 *   1. helmet — sets security headers before anything else can.
 *   2. cors — must run before parsers so OPTIONS preflights are answered.
 *   3. body parsers — JSON capped at 10 MB, urlencoded for form posts.
 *   4. cookie-parser — required by auth/refresh routes.
 *   5. compression — runs after parsers so encoded bodies aren't touched.
 *   6. requestLogger — assigns the correlation id as early as possible.
 *   7. routes (`/api`, plus `/healthz`, `/readyz` and `/source`).
 *   8. notFound, then global error handler (last).
 *
 * `createApp()` is pure — no `listen()`. The HTTP bootstrap lives in
 * `server.ts` so tests can mount the app under supertest without opening a
 * port.
 */
import express, { type Application } from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import { MAX_DOCUMENT_BYTES } from "@metis/shared";
import { requestLogger } from "./middleware/request-logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { apiRouter } from "./routes/index.js";
import { reconciliationJson } from "./routes/admin/auth-reconciliation.js";
import { deepHandler, liveHandler } from "./routes/health.js";
import { sourceHandler } from "./routes/source.js";
import { assertValidEmbedConfig } from "./lib/rag/embed-model-config.js";
import { metricsMiddleware } from "./lib/metrics/middleware.js";
import { metricsHandler } from "./lib/metrics/route.js";
import { mountSlackReceiver } from "./lib/slack/slack-receiver.js";

const JSON_LIMIT = "10mb"; // matches MAX_DOCUMENT_BYTES (10 MiB) for upload routes

/**
 * Issue #17.3 — parse the `TRUST_PROXY` env var into a safe value for
 * `app.set('trust proxy', ...)`.
 *
 * Express accepts a number of proxy hops, a boolean, or a string predicate
 * (`'loopback'`, an IP/subnet list, etc.). The previous `Number(env)` form
 * silently produced `NaN` for any non-numeric string, which Express coerces to
 * a truthy value — trusting EVERY hop and making the rate-limiter IP-spoofable.
 *
 * Rules:
 *   - unset                       → 1 (trust the first hop; the safe default)
 *   - a valid non-negative number → that number of hops
 *   - "true" / "false"            → boolean (Express's documented forms)
 *   - any other non-numeric string→ passed through verbatim (e.g. "loopback",
 *                                    "10.0.0.0/8") so existing predicate configs
 *                                    keep working
 *   - NaN / negative number       → fall back to 1 with a console.warn
 */
export function parseTrustProxy(raw: string | undefined): number | boolean | string {
  if (raw === undefined || raw.trim() === "") return 1;
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  // Numeric form: must be a finite, non-negative number of hops.
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      // eslint-disable-next-line no-console -- startup misconfig warning; runs in the app factory before the request logger is wired
      console.warn(`Invalid TRUST_PROXY="${raw}" (NaN/negative) — falling back to 1`);
      return 1;
    }
    return n;
  }
  // Non-numeric string: an Express predicate form (e.g. "loopback",
  // "127.0.0.1", "10.0.0.0/8"). Pass through unchanged.
  return trimmed;
}

export interface CreateAppOptions {
  /** Override CORS origin — defaults to `process.env.CORS_ORIGIN` or localhost:3000. */
  corsOrigin?: string;
  /** Disable rate limiting — used by tests that hammer auth endpoints. */
  disableRateLimit?: boolean;
}

export function createApp(opts: CreateAppOptions = {}): Application {
  // Issue #782 — FAIL AT BOOT, NOT PER REQUEST. `EMBED_POOLING_MAP` /
  // `EMBED_POOLING` / `EMBED_DTYPE` are otherwise only read when an embedding
  // backend is first constructed (lazily, on the first ingest/search), so a typo
  // would yield a server that boots, passes its health check, takes traffic, and
  // then fails every embed. Validating here crashloops the pod instead — instant
  // and unambiguous. This is the process boot path (index.ts → createServer →
  // createApp), not a request path: it can never turn a request into a 500.
  assertValidEmbedConfig();

  // Ensure the body limit constant is referenced (linter happiness + sanity).
  void MAX_DOCUMENT_BYTES;

  const app = express();

  app.disable("x-powered-by");
  // Trust the first reverse proxy hop so rate-limiter and request-logger see
  // the originating client IP. Tighten in deployment via TRUST_PROXY env.
  app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

  app.use(helmet());
  app.use(
    cors({
      origin: opts.corsOrigin ?? process.env.CORS_ORIGIN ?? "http://localhost:3000",
      credentials: true,
    }),
  );
  // Issue #579 — mount the Slack Bolt receiver BEFORE the global JSON body parser
  // so Bolt can read+verify the RAW request body (Slack signs the raw bytes; a
  // pre-parsed body would break signature verification). Mounted only when
  // SLACK_SIGNING_SECRET is configured (fail closed). Never throws at startup.
  try {
    mountSlackReceiver(app);
  } catch (err) {
    // eslint-disable-next-line no-console -- startup wiring warning, before the request logger is active
    console.warn(`Slack receiver not mounted: ${(err as Error).message}`);
  }
  app.use("/api/admin/auth/role-reconciliation", reconciliationJson);
  app.use(
    express.json({
      limit: JSON_LIMIT,
      // Capture raw body for HMAC-signed webhook routes (Epic #156).
      verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
        if (
          req.originalUrl?.startsWith("/api/triggers/") ||
          req.originalUrl?.startsWith("/api/webhooks/")
        ) {
          req.rawBody = buf.toString("utf8");
        }
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: JSON_LIMIT }));
  app.use(cookieParser());
  app.use(compression());
  app.use(requestLogger);
  app.use(metricsMiddleware);

  // Liveness/readiness aliases (issue #21 spec uses these names).
  app.get("/healthz", liveHandler);
  app.get("/readyz", deepHandler);
  // #1296 — the AGPL-3.0 §13 network source offer, unauthenticated and at the
  // top level so a remote user (or a tool) reaches it at the path they would
  // guess. Mounted again under `/api` in routes/index.ts for the UI footer,
  // which goes through the Next.js proxy. See routes/source.ts.
  app.get("/source", sourceHandler);
  // Prometheus scrape endpoint — gated by Bearer METRICS_TOKEN. Disabled
  // (returns 404) when METRICS_TOKEN is unset to fail closed by default.
  app.get("/metrics", metricsHandler);

  app.use("/api", apiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
