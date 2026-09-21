/**
 * ACP WebSocket server — Epic #163, Issue #119.
 *
 * Listens for `upgrade` events on the existing HTTP server and serves a
 * JSON-RPC 2.0 endpoint at `/api/acp`. Each frame is one envelope; the
 * handler dispatches via `dispatchAcp`.
 *
 * Auth: `Authorization: Bearer metis_...` header on the upgrade request.
 * Verified once at upgrade time and stored on the per-connection context.
 * Unauthorized clients are rejected with HTTP 401 BEFORE any frames are
 * sent (AC #3).
 *
 * Lifecycle (AC #4): `attachAcpServer` returns a teardown closure that
 * detaches the upgrade listener and closes every active socket with code
 * 1001 ("going away"). This is invoked from the admin disable flow + the
 * server shutdown path so existing sessions terminate gracefully.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { createChildLogger } from "../logger.js";
import { dispatchAcp, type AcpContext, type JsonRpcRequest } from "./handlers.js";
import { verifyApiToken, type VerifiedToken } from "./api-tokens.js";

const log = createChildLogger("acp-server");

export const ACP_PATH = "/api/acp";

export interface AcpServerHandle {
  /** Number of currently connected sockets. */
  readonly connectionCount: number;
  /** Detach the upgrade listener and close every active socket. */
  shutdown(): Promise<void>;
  /** Underlying ws server (test introspection). Null on disabled handles. */
  readonly wss: WebSocketServer | null;
}

export interface AttachAcpServerOptions {
  /** Inject a custom verifier for tests. */
  verify?: (token: string) => Promise<VerifiedToken | null>;
  /** Inject a dispatch override for tests. */
  dispatch?: typeof dispatchAcp;
}

/**
 * Wire an ACP WebSocket server to the given HTTP server. Idempotent if
 * called twice on the same instance — the previous handle is shutdown
 * first.
 */
export function attachAcpServer(
  http: HttpServer,
  opts: AttachAcpServerOptions = {},
): AcpServerHandle {
  const verify = opts.verify ?? verifyApiToken;
  const dispatch = opts.dispatch ?? dispatchAcp;
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  let active = true;

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!active) {
      rejectUpgrade(socket, 503, "ACP server disabled");
      return;
    }
    if (!request.url || !urlPathEquals(request.url, ACP_PATH)) {
      // Not for us — leave it alone for the next listener.
      return;
    }
    const token = extractBearer(request);
    if (!token) {
      rejectUpgrade(socket, 401, "ACP_UNAUTHORIZED: bearer token required");
      return;
    }
    let verified: VerifiedToken | null;
    try {
      verified = await verify(token);
    } catch (err) {
      log.warn("acp.verify.failed", { message: (err as Error).message });
      rejectUpgrade(socket, 500, "verification failed");
      return;
    }
    if (!verified) {
      rejectUpgrade(socket, 401, "ACP_UNAUTHORIZED: token invalid or revoked");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      registerSocket(ws, { auth: verified }, dispatch);
      ws.on("close", () => sockets.delete(ws));
      log.info("acp.connection.opened", {
        userId: verified!.userId,
        tokenId: verified!.tokenId,
      });
    });
  }

  http.on("upgrade", handleUpgrade);

  const handle: AcpServerHandle = {
    get connectionCount() {
      return sockets.size;
    },
    get wss() {
      return wss;
    },
    async shutdown(): Promise<void> {
      active = false;
      http.removeListener("upgrade", handleUpgrade);
      // 1001 "going away" — graceful shutdown.
      for (const ws of [...sockets]) {
        try {
          ws.close(1001, "ACP server shutting down");
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      log.info("acp.server.shutdown");
    },
  };
  return handle;
}

function registerSocket(ws: WebSocket, ctx: AcpContext, dispatch: typeof dispatchAcp): void {
  ws.on("message", async (raw) => {
    let req: JsonRpcRequest | null = null;
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf-8");
      req = JSON.parse(text) as JsonRpcRequest;
    } catch {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }),
      );
      return;
    }
    try {
      const res = await dispatch(req, ctx);
      ws.send(JSON.stringify(res));
    } catch (err) {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req?.id ?? null,
          error: { code: -32603, message: (err as Error).message ?? "internal error" },
        }),
      );
    }
  });
  ws.on("error", (err) => {
    log.warn("acp.socket.error", { message: err.message });
  });
}

export function extractBearer(request: IncomingMessage): string | null {
  const auth = request.headers["authorization"];
  if (typeof auth !== "string") return null;
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token || null;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
}

export function urlPathEquals(url: string, path: string): boolean {
  // Strip query string and trailing slash.
  const idx = url.indexOf("?");
  const u = (idx === -1 ? url : url.slice(0, idx)).replace(/\/+$/, "") || "/";
  const p = path.replace(/\/+$/, "") || "/";
  return u === p;
}
