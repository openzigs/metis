/**
 * Internal API base for browser-originating fetches. The Next.js route handlers
 * under `/api/*` proxy to the upstream Express server while keeping JWTs in
 * HttpOnly cookies — the client never sees a raw token. Override only for
 * server-only routes (where the upstream URL is read directly).
 */
export const API_BASE = "/api";

/**
 * Upstream backend base URL. Read from server env at request time so middleware
 * and route handlers can talk to the Express API.
 */
export const UPSTREAM_API_BASE = process.env.METIS_API_URL ?? "http://localhost:4000/api";

/** Cookie names the proxy mints on the Next.js origin. */
export const ACCESS_COOKIE = "metis.at";
export const REFRESH_COOKIE = "metis.rt";
