/**
 * #1117 — what a pre-auth rate limiter answers once a bucket is spent, shared by
 * every limiter keyed like `runs-rate-limit.ts` (`preauth:user:<id>` for a
 * token this server signed, at most 15 minutes expired; `preauth:peer:<addr>`
 * for everything else): the `/api/runs` guard, the discussion message
 * edit/delete guard and the source-divergence guard.
 *
 * A user's bucket is told 429 with the limiter's own body: it is theirs to wait
 * out. The PEER bucket only ever holds requests `requireAuth` refuses — no
 * token, an unsigned one, a refresh token, a token long expired — so each is
 * told what `requireAuth` tells it (`AUTH_REQUIRED`, `TOKEN_INVALID`,
 * `TOKEN_EXPIRED`), which the UI recovers from (refresh, else sign-in), with no
 * `Retry-After`. Should `requireAuth` ever accept one, it is still refused with
 * 429: the guard never lets a request past its budget.
 */
import type { NextFunction, Request, Response } from "express";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "./auth.js";

/** A pre-auth key on the shared peer bucket, as every pre-auth key function here writes it. */
const PEER_PREFIX = "preauth:peer:";

/**
 * Build the express-rate-limit `handler` for a pre-auth limiter whose key is
 * `keyOf(req)` and whose 429 body is `limited`.
 */
export function preAuthLimitReachedHandler(
  keyOf: (req: Request) => string,
  limited: ApiResponse,
): (req: unknown, res: unknown, next: unknown) => void {
  return (rawReq, rawRes, rawNext) => {
    const req = rawReq as Request;
    const res = rawRes as Response;
    const next = rawNext as NextFunction;
    const tooMany = () => {
      res.status(429).json(limited);
    };
    if (!keyOf(req).startsWith(PEER_PREFIX)) {
      tooMany();
      return;
    }
    // A 401 carries no promise that waiting helps.
    res.removeHeader("Retry-After");
    void requireAuth(req, res, (err?: unknown) => {
      if (err) next(err);
      else tooMany();
    });
  };
}
