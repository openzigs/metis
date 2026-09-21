/**
 * Cross-platform TCP port probe (Issue #188 / Epic #183).
 *
 * Replaces the `lsof`-based port check in `scripts/bootstrap-check.sh`, which
 * does not exist on Windows. Instead of inspecting OS process tables, we try to
 * BIND a server socket to the port: if the bind succeeds the port is free; if
 * it fails with `EADDRINUSE` the port is taken. This works identically on
 * Windows, macOS, and Linux using only Node's built-in `net` module.
 */
import net from "node:net";

/** Ports the local-dev stack expects to be available. */
export const EXPECTED_PORTS = Object.freeze([3000, 4000, 5050, 5432]);

/**
 * @typedef {object} PortResult
 * @property {number} port
 * @property {boolean} free   - true when nothing is listening on the port.
 * @property {string} [reason] - populated when `free` is false.
 */

/**
 * Probe a single TCP port by attempting to bind a listener on 127.0.0.1.
 *
 * @param {number} port
 * @param {object} [deps]
 * @param {() => net.Server} [deps.createServer] - injectable for tests.
 * @param {number} [deps.timeoutMs=1000]
 * @returns {Promise<PortResult>}
 */
export function probePort(port, deps = {}) {
  /* c8 ignore next — real net.createServer; tests inject createServer */
  const createServer = deps.createServer ?? (() => net.createServer());
  const timeoutMs = deps.timeoutMs ?? 1000;

  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;

    const done = (/** @type {PortResult} */ result) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => done({ port, free: false, reason: "probe timed out" }),
      timeoutMs,
    );
    if (typeof timer.unref === "function") timer.unref();

    server.once("error", (/** @type {NodeJS.ErrnoException} */ err) => {
      clearTimeout(timer);
      const reason = err.code === "EADDRINUSE" ? "in use" : err.code || "bind error";
      done({ port, free: false, reason });
    });

    server.once("listening", () => {
      clearTimeout(timer);
      done({ port, free: true });
    });

    try {
      server.listen(port, "127.0.0.1");
    } catch (err) {
      clearTimeout(timer);
      done({
        port,
        free: false,
        reason: err instanceof Error ? err.message : "listen threw",
      });
    }
  });
}

/**
 * Probe every port in `ports` (defaults to {@link EXPECTED_PORTS}).
 *
 * @param {number[]} [ports]
 * @param {object} [deps] - forwarded to {@link probePort}.
 * @returns {Promise<PortResult[]>}
 */
export async function probePorts(ports = [...EXPECTED_PORTS], deps = {}) {
  const results = [];
  for (const port of ports) {
    results.push(await probePort(port, deps));
  }
  return results;
}
