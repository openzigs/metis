/**
 * #221 — the HTTP server's keep-alive idle timeout, as an operator setting.
 *
 * Node closes an idle keep-alive socket `keepAliveTimeout` ms after the last
 * response (plus its own 1 s buffer) and advertises the value as
 * `Keep-Alive: timeout=N`. A client that REUSES a pooled socket at the moment
 * the server closes it gets `socket hang up` / `ECONNRESET` on a request the
 * server never read. Clients avoid that by expiring idle sockets before the
 * advertised timeout — but Node's `http.Agent` only honours the hint when the
 * agent itself has a `timeout`, so a plain `new Agent({ keepAlive: true })`
 * (which is what Playwright's API request pool is) never expires them.
 *
 * `HTTP_KEEP_ALIVE_TIMEOUT_MS` lets an operator line the server up with its
 * clients: above a proxy's idle timeout in production, or `0` (never close an
 * idle socket; the client closes it) for a harness whose client cannot track
 * the hint. `0` is for a closed harness only: on a server clients reach
 * directly, idle connections would stay open until each client closes them.
 * Unset keeps Node's default, so nothing changes unless it is set.
 */
import type { Server } from "node:http";
import { parseStrictMs } from "./env-ms.js";

export const HTTP_KEEP_ALIVE_TIMEOUT_ENV = "HTTP_KEEP_ALIVE_TIMEOUT_MS";

/**
 * Apply `HTTP_KEEP_ALIVE_TIMEOUT_MS` to `server`. Unset, blank or invalid keeps
 * the server's current value (Node's default); an invalid value also warns.
 *
 * @returns the keep-alive timeout now in force, in milliseconds.
 */
export function applyHttpKeepAliveTimeout(
  server: Pick<Server, "keepAliveTimeout">,
  env: NodeJS.ProcessEnv = process.env,
): number {
  server.keepAliveTimeout = parseStrictMs(
    HTTP_KEEP_ALIVE_TIMEOUT_ENV,
    env[HTTP_KEEP_ALIVE_TIMEOUT_ENV],
    server.keepAliveTimeout,
    {
      min: 0,
      warning: `Ignoring invalid ${HTTP_KEEP_ALIVE_TIMEOUT_ENV}; keeping Node's default keep-alive timeout`,
    },
  );
  return server.keepAliveTimeout;
}
