/**
 * #1445 review — the pre-auth guard for the custom-agent routes that act on a
 * project: the playground invoke (`POST /custom-agents/:id/invoke`, which also
 * sits behind chat's per-user `aiRateLimiter`) and the card's
 * `GET /custom-agents/projects/:projectId/disabled` read. The app has no global
 * limiter, and CodeQL `js/missing-rate-limiting` counts only a limiter that
 * runs BEFORE the authorization step, so this one is mounted in front of
 * `requireAuth`.
 *
 * Its key is `runsPreAuthKey` (`runs-rate-limit.ts`, #1007/#1117), never a
 * value the caller chooses: the user id inside an access token THIS server
 * signed (one that expired at most 15 minutes ago still counts as its user's),
 * otherwise the TCP peer, never `req.ip` or a header. A spent peer bucket
 * answers with `requireAuth`'s own 401 instead of a 429
 * (`preauth-limit-handler.ts`), so a browser whose cookie fell out reaches the
 * 401 it recovers from. Coarse by design: default 20000 per 15 minutes
 * (`CUSTOM_AGENTS_PREAUTH_LIMIT_MAX`); the window is `RUNS_LIMIT_WINDOW_MS`.
 *
 * Exported as the `rateLimit()` result itself (not wrapped) so CodeQL sees it.
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { runsPreAuthKey } from "./runs-rate-limit.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const CUSTOM_AGENTS_PREAUTH_DEFAULT_MAX = 20_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("RUNS_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "CUSTOM_AGENTS_RATE_LIMITED",
    message: "Too many custom-agent requests — slow down",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const customAgentsPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("custom-agents-preauth"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("CUSTOM_AGENTS_PREAUTH_LIMIT_MAX", CUSTOM_AGENTS_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  // #1117 — a spent user bucket is 429; a spent peer bucket is requireAuth's 401.
  handler: preAuthLimitReachedHandler(runsPreAuthKey, limited),
}) as unknown as RequestHandler;
