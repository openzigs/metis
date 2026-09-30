/**
 * #588 — a socket ALREADY subscribed to `mcp:status` loses its workspace room
 * when the workspace is soft-deleted or the user is removed from it, and a
 * repeated `subscribe:mcp` leaves workspace rooms no longer in the live set.
 * Before this, #562 only fixed what a subscribe JOINS; a socket that joined
 * before the delete/removal kept the room until it unsubscribed or reconnected.
 *
 * Real Socket.IO server and clients, the real `bootstrapMCP` emit path and the
 * real workspaces router (supertest) with Prisma mocked over an in-memory
 * membership table. Coordinators hold `mcp.manage`, so every subscriber passes
 * the room's role gate — what is under test is which events each one receives.
 */
import http from "node:http";
import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

// The database, as the mocked Prisma client sees it. Every test REPLACES it in
// its own body (never at module scope): server vitest has `retry: 2`, and a
// retry must start from the fixture again, not from what the failed attempt's
// DELETE left behind.
const db = vi.hoisted(() => ({
  /** `${workspaceId}:${userId}` → membership. */
  members: new Map<string, { workspaceId: string; userId: string }>(),
  deletedWorkspaces: new Set<string>(),
  /** projectId → workspaceId, for the MCP status emitter's project lookup. */
  projects: new Map<string, string>(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn() },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    workspace: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        slug: where.id,
      })),
      update: vi.fn(async ({ where }: { where: { id: string } }) => {
        db.deletedWorkspaces.add(where.id);
        return { id: where.id };
      }),
    },
    workspaceMember: {
      // `readLiveWorkspaceIds` — honours the live-workspace filter.
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; workspace?: { deletedAt: null } } }) =>
          [...db.members.values()]
            .filter((m) => m.userId === where.userId)
            .filter(
              (m) =>
                !(where.workspace?.deletedAt === null && db.deletedWorkspaces.has(m.workspaceId)),
            )
            .map((m) => ({ workspaceId: m.workspaceId })),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const m = db.members.get(where.id);
        return m ? { id: where.id, ...m, role: "member" } : null;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        db.members.delete(where.id);
        return { id: where.id };
      }),
      count: vi.fn(async () => 1),
    },
    project: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const workspaceId = db.projects.get(where.id);
        return workspaceId ? { workspaceId } : null;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { bootstrapMCP, type MCPBootstrap } from "../src/lib/mcp/index.js";
import type { MCPServerConfig } from "../src/lib/mcp/types.js";
import { MCP_STATUS_ROOM, mcpStatusWorkspaceRoom } from "../src/lib/mcp/status-rooms.js";
import { workspacesRouter } from "../src/routes/workspaces.js";

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;
let mcp: MCPBootstrap;
let app: Express;

beforeAll(async () => {
  httpServer = http.createServer();
  io = createSocketServer(httpServer);
  registerSocketServer(io);
  mcp = bootstrapMCP({ io, startHealthMonitor: false });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") port = addr.port;
      resolve();
    });
  });
  // A system admin acts on the workspace (bypasses the workspace-role check).
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: object }).user = {
      userId: "u-acting-admin",
      role: "admin",
      workspaces: [],
    };
    next();
  });
  app.use("/workspaces", workspacesRouter());
});

afterAll(async () => {
  registerSocketServer(null as never);
  await mcp.shutdown();
  await io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const open: ClientSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

const roomHas = (room: string, sid: string) =>
  io.sockets.adapter.rooms.get(room)?.has(sid) ?? false;

interface Subscriber {
  socket: ClientSocket;
  labels: string[];
  sid: string;
}

/** Seed the in-memory database for one test attempt. */
function seed(memberships: Array<[workspaceId: string, userId: string]>): void {
  db.members = new Map(
    memberships.map(([workspaceId, userId]) => [
      `${workspaceId}:${userId}`,
      { workspaceId, userId },
    ]),
  );
  db.deletedWorkspaces = new Set();
  db.projects = new Map(
    [...new Set(memberships.map(([ws]) => ws))].map((ws) => [`p-${ws}`, ws] as const),
  );
}

async function subscribe(userId: string, role: "admin" | "coordinator"): Promise<Subscriber> {
  const { accessToken } = issueTokens({
    userId,
    username: userId,
    role,
    permissions: [],
    workspaces: [],
  });
  const socket = ioClient(`http://127.0.0.1:${port}`, {
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
  const sid = socket.id!;
  const sub: Subscriber = { socket, labels: [], sid };
  socket.on("mcp:status", (e: { label: string }) => sub.labels.push(e.label));
  socket.emit("subscribe:mcp");
  await vi.waitFor(() => expect(roomHas(MCP_STATUS_ROOM, sid)).toBe(true));
  return sub;
}

function projectServer(workspaceId: string, label: string): MCPServerConfig {
  return {
    id: label,
    scope: "project",
    projectId: `p-${workspaceId}`,
    userId: null,
    label,
    transport: "stdio",
    runtime: "native",
    command: "node",
    args: null,
    url: null,
    headers: null,
    env: null,
    envSecretRefs: null,
    trustLevel: "untrusted",
    defaultToolRisk: "medium",
    version: null,
    sha256: null,
    healthCheckIntervalSec: 60,
    enabled: false,
  };
}

/** Emit one project event per workspace, then a global sentinel all subscribers get. */
async function emitAndSettle(
  subs: Subscriber[],
  workspaceIds: string[],
  tag: string,
): Promise<void> {
  for (const ws of workspaceIds) await mcp.lifecycle.start(projectServer(ws, `${ws}-${tag}`));
  const sentinel = `sentinel-${tag}`;
  await mcp.lifecycle.start({
    ...projectServer("none", sentinel),
    scope: "global",
    projectId: null,
  });
  await vi.waitFor(() => {
    for (const s of subs) expect(s.labels).toContain(sentinel);
  });
}

describe("#588 already-subscribed sockets leave workspace rooms they no longer belong to", () => {
  it("member removal evicts every socket of that user from that workspace's room only", async () => {
    seed([
      ["ws-a", "u-gone"],
      ["ws-b", "u-gone"],
      ["ws-a", "u-kept"],
    ]);
    const gone = await subscribe("u-gone", "coordinator");
    const goneTab2 = await subscribe("u-gone", "coordinator");
    const kept = await subscribe("u-kept", "coordinator");
    const admin = await subscribe("u-admin588a", "admin");
    const all = [gone, goneTab2, kept, admin];
    await vi.waitFor(() => {
      for (const s of [gone, goneTab2, kept]) {
        expect(roomHas(mcpStatusWorkspaceRoom("ws-a"), s.sid)).toBe(true);
      }
    });

    const res = await request(app).delete("/workspaces/ws-a/members/ws-a:u-gone");
    expect(res.status).toBe(200);

    for (const s of [gone, goneTab2]) {
      expect(roomHas(mcpStatusWorkspaceRoom("ws-a"), s.sid)).toBe(false);
      // Only the workspace the user was removed from.
      expect(roomHas(mcpStatusWorkspaceRoom("ws-b"), s.sid)).toBe(true);
    }
    expect(roomHas(mcpStatusWorkspaceRoom("ws-a"), kept.sid)).toBe(true);

    await emitAndSettle(all, ["ws-a", "ws-b"], "removal");
    for (const s of [gone, goneTab2]) {
      expect(s.labels).not.toContain("ws-a-removal");
      expect(s.labels).toContain("ws-b-removal");
    }
    expect(kept.labels).toContain("ws-a-removal");
    expect(admin.labels).toContain("ws-a-removal");
  });

  it("workspace soft-delete evicts every member's socket; other workspaces are untouched", async () => {
    seed([
      ["ws-c", "u-x"],
      ["ws-c", "u-y"],
      ["ws-d", "u-x"],
      ["ws-d", "u-z"],
    ]);
    const x = await subscribe("u-x", "coordinator");
    const y = await subscribe("u-y", "coordinator");
    const z = await subscribe("u-z", "coordinator");
    const admin = await subscribe("u-admin588b", "admin");
    const all = [x, y, z, admin];
    await vi.waitFor(() => {
      expect(roomHas(mcpStatusWorkspaceRoom("ws-c"), x.sid)).toBe(true);
      expect(roomHas(mcpStatusWorkspaceRoom("ws-c"), y.sid)).toBe(true);
      expect(roomHas(mcpStatusWorkspaceRoom("ws-d"), z.sid)).toBe(true);
    });

    const res = await request(app).delete("/workspaces/ws-c");
    expect(res.status).toBe(200);

    expect(io.sockets.adapter.rooms.get(mcpStatusWorkspaceRoom("ws-c"))).toBeUndefined();
    expect(roomHas(mcpStatusWorkspaceRoom("ws-d"), x.sid)).toBe(true);
    expect(roomHas(mcpStatusWorkspaceRoom("ws-d"), z.sid)).toBe(true);

    await emitAndSettle(all, ["ws-c", "ws-d"], "delete");
    for (const s of [x, y, z]) expect(s.labels).not.toContain("ws-c-delete");
    expect(admin.labels).toContain("ws-c-delete");
    expect(x.labels).toContain("ws-d-delete");
    expect(z.labels).toContain("ws-d-delete");
  });

  it("a repeated subscribe:mcp leaves workspace rooms no longer in the live set", async () => {
    seed([
      ["ws-e", "u-r"],
      ["ws-f", "u-r"],
    ]);
    const r = await subscribe("u-r", "coordinator");
    await vi.waitFor(() => {
      expect(roomHas(mcpStatusWorkspaceRoom("ws-e"), r.sid)).toBe(true);
      expect(roomHas(mcpStatusWorkspaceRoom("ws-f"), r.sid)).toBe(true);
    });

    // The membership row goes away without passing through the route (another
    // process, a direct DB change): only the re-subscribe can notice. A SCIM
    // deprovision does NOT take this path — it keeps the WorkspaceMember rows,
    // so neither this prune nor readLiveWorkspaceIds covers it (tracked separately).
    db.members.delete("ws-e:u-r");
    r.socket.emit("subscribe:mcp");
    await vi.waitFor(() => expect(roomHas(mcpStatusWorkspaceRoom("ws-e"), r.sid)).toBe(false));
    expect(roomHas(mcpStatusWorkspaceRoom("ws-f"), r.sid)).toBe(true);
    expect(roomHas(MCP_STATUS_ROOM, r.sid)).toBe(true);

    await emitAndSettle([r], ["ws-e", "ws-f"], "resub");
    expect(r.labels).not.toContain("ws-e-resub");
    expect(r.labels).toContain("ws-f-resub");
  });
});
