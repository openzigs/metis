/**
 * #622 — two METIS Socket.IO "replicas" in one process: each is its own HTTP
 * server running the real `createSocketServer`, optionally sharing a cluster
 * adapter, so a test can connect a user to the replica that does NOT run an
 * eviction and watch whether the eviction reaches it. The Prisma mock both
 * suites share is `two-replica-prisma.ts`.
 */
import http from "node:http";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type { ServerOptions } from "socket.io";
import { createSocketServer, type MetisIOServer } from "../../src/lib/socket/server.js";
import { issueTokens } from "../../src/lib/auth/jwt.js";

export interface Replica {
  io: MetisIOServer;
  port: number;
  /** Is the socket with this id, connected HERE, in `room` on this replica? */
  roomHas(room: string, sid: string): boolean;
  close(): Promise<void>;
}

export async function startReplica(adapter?: ServerOptions["adapter"]): Promise<Replica> {
  const httpServer = http.createServer();
  const io = createSocketServer(httpServer, { adapter });
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      resolve(addr && typeof addr === "object" ? addr.port : 0);
    });
  });
  return {
    io,
    port,
    roomHas: (room, sid) => io.sockets.adapter.rooms.get(room)?.has(sid) ?? false,
    close: async () => {
      await io.close();
      if (httpServer.listening) await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

export interface Connected {
  socket: ClientSocket;
  sid: string;
  disconnectReason: string | null;
}

/** Connect `userId` to `replica`, subscribe to MCP status, and wait for its rooms. */
export async function connectUser(
  replica: Replica,
  userId: string,
  open: ClientSocket[],
): Promise<Connected> {
  const { accessToken } = issueTokens({
    userId,
    username: userId,
    role: "coordinator",
    permissions: [],
    workspaces: [],
  });
  const socket = ioClient(`http://127.0.0.1:${replica.port}`, {
    auth: { token: accessToken },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000,
  });
  open.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.on("auth:ok", () => resolve());
    socket.on("connect_error", reject);
  });
  const conn: Connected = { socket, sid: socket.id!, disconnectReason: null };
  socket.on("disconnect", (reason) => {
    conn.disconnectReason = reason;
  });
  socket.emit("subscribe:mcp");
  return conn;
}
