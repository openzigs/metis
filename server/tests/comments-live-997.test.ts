/**
 * #997 — a requirement's comment panel shows another user's reply live.
 *
 * Server half: every comment write (new thread, reply, edit, delete) on a
 * requirement or Spec Kit artifact emits `comment:changed` to the thread's
 * `project:{id}` room, identifiers only — and a write the routes refuse emits
 * nothing. Also pins that the thread list is not filtered by author, which was
 * one of the two candidate causes the issue named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  requirement: { findUnique: vi.fn() },
  commentThread: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  comment: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  project: { findUnique: vi.fn(), findFirst: vi.fn() },
};
vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

const testUser: Record<string, unknown> = {
  userId: "user-1",
  username: "alice",
  role: "admin",
  permissions: ["project.read"],
};
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: typeof testUser }).user = { ...testUser };
    next();
  },
}));
vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../src/lib/collaboration/mentions.js", () => ({
  dispatchMentions: vi.fn(),
  refreshCommentMentionExcerpts: vi.fn().mockResolvedValue(undefined),
  retractCommentMentionExcerpts: vi.fn().mockResolvedValue(undefined),
}));

const emit = vi.fn();
const to = vi.fn((_room: string) => ({ emit }));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => ({ to }) }));

const { requirementCommentsRouter, commentsRouter, specKitArtifactCommentsRouter } =
  await import("../src/routes/comments.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/requirements/:requirementId/comments", requirementCommentsRouter());
  app.use("/comments", commentsRouter());
  app.use(
    "/projects/:projectId/spec-kit/artifacts/:artifactName/comments",
    specKitArtifactCommentsRouter(),
  );
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { statusCode?: number; code?: string; message?: string };
      res.status(e.statusCode ?? 500).json({ error: { code: e.code, message: e.message } });
    },
  );
  return app;
}

const at = new Date("2026-10-21T00:00:00Z");
function comment(over: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    threadId: "thread-1",
    authorId: "user-1",
    body: "Secret body",
    editedAt: null,
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
    author: { id: "user-1", username: "alice", displayName: "Alice" },
    ...over,
  };
}

type Select = Record<string, true | { select: Select }>;

/** Prisma's `select`, applied to a fixture row: only what the route asked for comes back. */
function project(row: unknown, select: Select | undefined): unknown {
  if (!select || row === null || typeof row !== "object") return row;
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    out[key] = spec === true ? source[key] : project(source[key], spec.select);
  }
  return out;
}

/**
 * A `findUnique` double that honours `select`. A route that stops selecting a
 * column it needs (e.g. `specKitArtifactName`) then sees it missing, as it
 * would against the database, instead of the fixture handing it over anyway.
 */
function selecting(row: unknown) {
  return async (args: { select?: Select }) => project(row, args.select);
}

const requirementThread = {
  id: "thread-1",
  requirementId: "req-1",
  specKitProjectId: null,
  specKitArtifactName: null,
  requirement: { projectId: "proj-1" },
};
const artifactThread = {
  id: "thread-sk",
  requirementId: null,
  specKitProjectId: "proj-2",
  specKitArtifactName: "spec.md",
  requirement: null,
};

const requirementEvent = {
  projectId: "proj-1",
  threadId: "thread-1",
  requirementId: "req-1",
  artifactName: null,
  ts: expect.any(Number),
};
const artifactEvent = {
  projectId: "proj-2",
  threadId: "thread-sk",
  requirementId: null,
  artifactName: "spec.md",
  ts: expect.any(Number),
};

function expectOneChange(room: string, payload: Record<string, unknown>) {
  expect(to).toHaveBeenCalledTimes(1);
  expect(to).toHaveBeenCalledWith(room);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith("comment:changed", payload);
  // Identifiers only: the body is re-read over the permission-checked route.
  expect(JSON.stringify(emit.mock.calls[0][1])).not.toContain("Secret body");
}

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
});

describe("comment:changed on every write (#997)", () => {
  it("a new requirement thread tells the requirement's project room", async () => {
    mockPrisma.requirement.findUnique.mockResolvedValue({ id: "req-1", projectId: "proj-1" });
    mockPrisma.commentThread.create.mockResolvedValue({
      id: "thread-1",
      requirementId: "req-1",
      title: null,
      resolved: false,
      createdAt: at,
      updatedAt: at,
      comments: [comment()],
    });

    const res = await request(app).post("/requirements/req-1/comments").send({ body: "Hi" });

    expect(res.status).toBe(201);
    expectOneChange("project:proj-1", requirementEvent);
  });

  it("a new artifact thread tells the artifact's project room", async () => {
    mockPrisma.commentThread.create.mockResolvedValue({
      id: "thread-sk",
      specKitProjectId: "proj-2",
      specKitArtifactName: "spec.md",
      title: null,
      resolved: false,
      createdAt: at,
      updatedAt: at,
      comments: [comment({ threadId: "thread-sk" })],
    });

    const res = await request(app)
      .post("/projects/proj-2/spec-kit/artifacts/spec.md/comments")
      .send({ body: "Hi" });

    expect(res.status).toBe(201);
    expectOneChange("project:proj-2", artifactEvent);
  });

  it("a reply on a requirement thread tells its project room", async () => {
    mockPrisma.commentThread.findUnique.mockImplementation(selecting(requirementThread));
    mockPrisma.comment.create.mockResolvedValue(comment({ id: "c-2" }));

    const res = await request(app).post("/comments/thread-1/replies").send({ body: "Reply" });

    expect(res.status).toBe(201);
    expectOneChange("project:proj-1", requirementEvent);
  });

  it("a reply on an artifact thread names the artifact", async () => {
    mockPrisma.commentThread.findUnique.mockImplementation(selecting(artifactThread));
    mockPrisma.comment.create.mockResolvedValue(comment({ threadId: "thread-sk" }));

    const res = await request(app).post("/comments/thread-sk/replies").send({ body: "Reply" });

    expect(res.status).toBe(201);
    expectOneChange("project:proj-2", artifactEvent);
  });

  it("an edit tells the project room", async () => {
    mockPrisma.comment.findUnique.mockImplementation(
      selecting({
        id: "c-1",
        authorId: "user-1",
        deletedAt: null,
        thread: requirementThread,
      }),
    );
    mockPrisma.comment.update.mockResolvedValue(comment({ editedAt: at }));

    const res = await request(app).patch("/comments/c-1").send({ body: "Edited" });

    expect(res.status).toBe(200);
    expectOneChange("project:proj-1", requirementEvent);
  });

  it("a delete tells the project room", async () => {
    mockPrisma.comment.findUnique.mockImplementation(
      selecting({
        id: "c-1",
        authorId: "user-1",
        deletedAt: null,
        thread: requirementThread,
      }),
    );
    mockPrisma.comment.update.mockResolvedValue({});

    const res = await request(app).delete("/comments/c-1");

    expect(res.status).toBe(200);
    expectOneChange("project:proj-1", requirementEvent);
  });

  it("a delete on an artifact thread names the artifact", async () => {
    mockPrisma.comment.findUnique.mockImplementation(
      selecting({ id: "c-1", authorId: "user-1", deletedAt: null, thread: artifactThread }),
    );
    mockPrisma.comment.update.mockResolvedValue({});

    const res = await request(app).delete("/comments/c-1");

    expect(res.status).toBe(200);
    expectOneChange("project:proj-2", artifactEvent);
  });

  it("an admin's reply on a thread with no project tells nobody", async () => {
    mockPrisma.commentThread.findUnique.mockImplementation(
      selecting({
        ...requirementThread,
        requirementId: null,
        requirement: null,
      }),
    );
    mockPrisma.comment.create.mockResolvedValue(comment());

    const res = await request(app).post("/comments/thread-1/replies").send({ body: "Reply" });

    expect(res.status).toBe(201);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a refused edit (not the author) emits nothing", async () => {
    mockPrisma.comment.findUnique.mockImplementation(
      selecting({
        id: "c-1",
        authorId: "someone-else",
        deletedAt: null,
        thread: requirementThread,
      }),
    );

    const res = await request(app).patch("/comments/c-1").send({ body: "Edited" });

    expect(res.status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a write still succeeds when the socket emit throws", async () => {
    emit.mockImplementationOnce(() => {
      throw new Error("adapter down");
    });
    mockPrisma.commentThread.findUnique.mockImplementation(selecting(requirementThread));
    mockPrisma.comment.create.mockResolvedValue(comment());

    const res = await request(app).post("/comments/thread-1/replies").send({ body: "Reply" });

    expect(res.status).toBe(201);
  });
});

describe("a non-member's write is refused before any emit (#997)", () => {
  beforeEach(() => {
    Object.assign(testUser, { userId: "user-2", role: "developer", workspaces: ["ws-B"] });
    mockPrisma.project.findFirst.mockImplementation(async (args: { where: { id: string } }) => ({
      id: args.where.id,
    }));
    mockPrisma.project.findUnique.mockResolvedValue({
      workspaceId: "ws-A",
      workspace: { deletedAt: null, members: [] },
    });
  });
  afterEach(() => {
    Object.assign(testUser, { userId: "user-1", role: "admin" });
    delete testUser.workspaces;
  });

  it("a reply on another workspace's thread is the 404 and tells nobody", async () => {
    mockPrisma.commentThread.findUnique.mockImplementation(selecting(requirementThread));

    const res = await request(app).post("/comments/thread-1/replies").send({ body: "Reply" });

    expect(res.status).toBe(404);
    expect(mockPrisma.comment.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("the thread list is not filtered by author (#997)", () => {
  it("returns every user's comments, so a re-read shows the other user's reply", async () => {
    mockPrisma.requirement.findUnique.mockResolvedValue({ id: "req-1", projectId: "proj-1" });
    mockPrisma.commentThread.findMany.mockResolvedValue([
      {
        id: "thread-1",
        requirementId: "req-1",
        title: null,
        resolved: false,
        createdAt: at,
        updatedAt: at,
        comments: [
          comment({ id: "c-1", body: "From admin" }),
          comment({
            id: "c-2",
            authorId: "user-9",
            body: "From coordinator",
            author: { id: "user-9", username: "coord", displayName: "Coordinator" },
          }),
        ],
      },
    ]);

    const res = await request(app).get("/requirements/req-1/comments");

    expect(res.status).toBe(200);
    expect(res.body.data[0].comments.map((c: { body: string }) => c.body)).toEqual([
      "From admin",
      "From coordinator",
    ]);
    const where = mockPrisma.commentThread.findMany.mock.calls[0][0];
    expect(JSON.stringify(where)).not.toContain("authorId");
  });
});
