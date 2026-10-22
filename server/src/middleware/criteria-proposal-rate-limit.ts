/**
 * Issue #1389 — rate limiters for answering the acceptance criteria a
 * re-synthesis suggested for approved requirements:
 * `POST /api/requirements/:requirementId/criteria-proposal` (one requirement)
 * and `POST /api/analyses/:id/criteria-proposals/dismiss` (every one on the
 * analysis). Same shape and defaults as `source-divergence-rate-limit.ts`
 * (#1220), whose header explains the reasoning:
 *
 *  - {@link criteriaProposalUserRateLimiter} — AFTER `requireAuth`, keyed on
 *    `req.user.userId`. Default 300 per 15 minutes (`CRITERIA_PROPOSAL_LIMIT_MAX`).
 *  - {@link criteriaProposalPreAuthRateLimiter} — in FRONT of `requireAuth`, keyed
 *    on the user id in an access token this server signed, else the TCP peer,
 *    never `req.ip`. Default 20000 per 15 minutes
 *    (`CRITERIA_PROPOSAL_PREAUTH_LIMIT_MAX`). A spent peer bucket answers
 *    `requireAuth`'s 401, not 429 (#1117).
 *
 * Separate stores and a 429 body of their own, so the message names what the
 * caller was doing. Caps are read per request; the window once
 * (`CRITERIA_PROPOSAL_LIMIT_WINDOW_MS`).
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { runsPreAuthKey, runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const CRITERIA_PROPOSAL_USER_DEFAULT_MAX = 300;
export const CRITERIA_PROPOSAL_PREAUTH_DEFAULT_MAX = 20_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("CRITERIA_PROPOSAL_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "CRITERIA_PROPOSAL_RATE_LIMITED",
    message: "Too many answers to suggested acceptance criteria — slow down",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const criteriaProposalPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("criteria-proposal-preauth"),
  windowMs: WINDOW_MS,
  limit: () =>
    intFromEnv("CRITERIA_PROPOSAL_PREAUTH_LIMIT_MAX", CRITERIA_PROPOSAL_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  handler: preAuthLimitReachedHandler(runsPreAuthKey, limited),
}) as unknown as RequestHandler;

export const criteriaProposalUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("criteria-proposal-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("CRITERIA_PROPOSAL_LIMIT_MAX", CRITERIA_PROPOSAL_USER_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
