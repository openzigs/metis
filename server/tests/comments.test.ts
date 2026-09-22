/**
 * Epic #728 / Issue #730 — Comment REST API tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// ---- Mocks -----------------------------------------------------------------

const mockPrisma = {
  requirement: { findUnique: vi.fn() },
  commentThread: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  comment: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  project: {
    findMany: vi.fn(),
  },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

// Mutable test-user — mutate this to switch roles between test suites.
const testUser = {
  userId: "user-1",
  username: "alice",
  role: "admin",
  permissions: ["project.read", "project.update"],
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
  fanOutMentions: vi.fn().mockResolvedValue(undefined),
  dispatchMentions: vi.fn(),
}));

const { requirementCommentsRouter, commentsRouter, specKitArtifactCommentsRouter } =
  await import("../src/routes/comments.js");

// ---- App factory -----------------------------------------------------------

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
      const e = err as { statusCode?: number; status?: number; code?: string; message?: string };
      res.status(e.statusCode ?? e.status ?? 500).json({
        error: { code: e.code ?? "INTERNAL", message: e.message ?? "?" },
      });
    },
  );
  return app;
}

// ---- Tests -----------------------------------------------------------------

describe("requirement comments router", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  describe("POST /requirements/:requirementId/comments", () => {
    it("creates a thread with first comment", async () => {
      mockPrisma.requirement.findUnique.mockResolvedValue({ id: "req-1", projectId: "proj-1" });
      mockPrisma.commentThread.create.mockResolvedValue({
        id: "thread-1",
        requirementId: "req-1",
        title: "Issue",
        resolved: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        comments: [
          {
            id: "comment-1",
            threadId: "thread-1",
            authorId: "user-1",
            body: "Hello @bob",
            editedAt: null,
            deletedAt: null,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            author: { id: "user-1", username: "alice", displayName: "Alice" },
          },
        ],
      });

      const res = await request(app)
        .post("/requirements/req-1/comments")
        .send({ title: "Issue", body: "Hello @bob" });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("thread-1");
      expect(res.body.data.comments).toHaveLength(1);
      expect(res.body.data.comments[0].body).toBe("Hello @bob");
    });

    it("returns 404 when requirement not found", async () => {
      mockPrisma.requirement.findUnique.mockResolvedValue(null);

      const res = await request(app).post("/requirements/bad-id/comments").send({ body: "Hello" });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
    });

    it("returns 400 for missing body", async () => {
      const res = await request(app).post("/requirements/req-1/comments").send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /requirements/:requirementId/comments", () => {
    it("lists a soft-deleted comment as a placeholder (blank body, deleted: true)", async () => {
      mockPrisma.requirement.findUnique.mockResolvedValue({ id: "req-1", projectId: "proj-1" });
      mockPrisma.commentThread.findMany.mockResolvedValue([
        {
          id: "thread-1",
          requirementId: "req-1",
          title: null,
          resolved: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          comments: [
            {
              id: "c-gone",
              threadId: "thread-1",
              authorId: "user-1",
              body: "Deleted by its author",
              editedAt: null,
              deletedAt: new Date("2024-01-02"),
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-02"),
              author: { id: "user-1", username: "alice", displayName: "Alice" },
            },
          ],
        },
      ]);

      const res = await request(app).get("/requirements/req-1/comments");

      expect(res.status).toBe(200);
      // The thread query must NOT filter deleted comments out — the client
      // renders the placeholder and relies on the row still being there.
      const where = mockPrisma.commentThread.findMany.mock.calls[0][0];
      expect(where.include.comments.where).toBeUndefined();
      expect(res.body.data[0].comments).toHaveLength(1);
      expect(res.body.data[0].comments[0].deleted).toBe(true);
      expect(res.body.data[0].comments[0].body).toBeNull();
    });

    it("lists threads with non-deleted comments", async () => {
      mockPrisma.requirement.findUnique.mockResolvedValue({ id: "req-1", projectId: "proj-1" });
      mockPrisma.commentThread.findMany.mockResolvedValue([
        {
          id: "thread-1",
          requirementId: "req-1",
          title: null,
          resolved: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          comments: [
            {
              id: "c-1",
              threadId: "thread-1",
              authorId: "user-1",
              body: "Hello",
              editedAt: null,
              deletedAt: null,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              author: { id: "user-1", username: "alice", displayName: "Alice" },
            },
          ],
        },
      ]);

      const res = await request(app).get("/requirements/req-1/comments");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].comments[0].body).toBe("Hello");
    });
  });
});

describe("comments router", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  describe("POST /comments/:threadId/replies", () => {
    it("creates a reply", async () => {
      mockPrisma.commentThread.findUnique.mockResolvedValue({
        id: "thread-1",
        requirementId: "req-1",
        specKitProjectId: null,
        requirement: { projectId: "proj-1" },
      });
      mockPrisma.comment.create.mockResolvedValue({
        id: "reply-1",
        threadId: "thread-1",
        authorId: "user-1",
        body: "My reply",
        editedAt: null,
        deletedAt: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        author: { id: "user-1", username: "alice", displayName: "Alice" },
      });

      const res = await request(app).post("/comments/thread-1/replies").send({ body: "My reply" });

      expect(res.status).toBe(201);
      expect(res.body.data.body).toBe("My reply");
    });

    it("returns 404 when thread not found", async () => {
      mockPrisma.commentThread.findUnique.mockResolvedValue(null);

      const res = await request(app).post("/comments/bad-thread/replies").send({ body: "reply" });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("THREAD_NOT_FOUND");
    });
  });

  describe("PATCH /comments/:commentId", () => {
    it("edits own comment", async () => {
      mockPrisma.comment.findUnique.mockResolvedValue({
        id: "c-1",
        authorId: "user-1",
        deletedAt: null,
        thread: {
          requirementId: "req-1",
          specKitProjectId: null,
          requirement: { projectId: "proj-1" },
        },
      });
      mockPrisma.comment.update.mockResolvedValue({
        id: "c-1",
        threadId: "thread-1",
        authorId: "user-1",
        body: "Updated body",
        editedAt: new Date(),
        deletedAt: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date(),
        author: { id: "user-1", username: "alice", displayName: "Alice" },
      });

      const res = await request(app).patch("/comments/c-1").send({ body: "Updated body" });

      expect(res.status).toBe(200);
      expect(res.body.data.body).toBe("Updated body");
    });

    it("returns 403 when editing another user's comment", async () => {
      mockPrisma.comment.findUnique.mockResolvedValue({
        id: "c-1",
        authorId: "user-OTHER",
        deletedAt: null,
        thread: {
          requirementId: "req-1",
          specKitProjectId: null,
          requirement: { projectId: "proj-1" },
        },
      });

      const res = await request(app).patch("/comments/c-1").send({ body: "hacked" });

      expect(res.status).toBe(403);
    });

    it("returns 404 for deleted comment", async () => {
      mockPrisma.comment.findUnique.mockResolvedValue({
        id: "c-1",
        authorId: "user-1",
        deletedAt: new Date(),
        thread: {
          requirementId: "req-1",
          specKitProjectId: null,
          requirement: { projectId: "proj-1" },
        },
      });

      const res = await request(app).patch("/comments/c-1").send({ body: "update" });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /comments/:commentId", () => {
    it("soft deletes own comment", async () => {
      mockPrisma.comment.findUnique.mockResolvedValue({
        id: "c-1",
        authorId: "user-1",
        deletedAt: null,
        thread: {
          requirementId: "req-1",
          specKitProjectId: null,
          requirement: { projectId: "proj-1" },
        },
      });
      mockPrisma.comment.update.mockResolvedValue({ id: "c-1" });

      const res = await request(app).delete("/comments/c-1");

      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
    });

    it("returns 403 when deleting another user's comment", async () => {
      mockPrisma.comment.findUnique.mockResolvedValue({
        id: "c-1",
        authorId: "user-OTHER",
        deletedAt: null,
        thread: {
          requirementId: "req-1",
          specKitProjectId: null,
          requirement: { projectId: "proj-1" },
        },
      });

      const res = await request(app).delete("/comments/c-1");

      expect(res.status).toBe(403);
    });
  });
});

// ---- Spec Kit artifact comment routes --------------------------------------

describe("spec kit artifact comments router", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it("creates a thread + first comment on an artifact (mention dispatch wired)", async () => {
    mockPrisma.commentThread.create.mockResolvedValue({
      id: "thread-sk",
      specKitProjectId: "proj-1",
      specKitArtifactName: "spec.md",
      title: null,
      resolved: false,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      comments: [
        {
          id: "comment-sk",
          threadId: "thread-sk",
          authorId: "user-1",
          body: "cc @bob",
          editedAt: null,
          deletedAt: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          author: { id: "user-1", username: "alice", displayName: "Alice" },
        },
      ],
    });

    const res = await request(app)
      .post("/projects/proj-1/spec-kit/artifacts/spec.md/comments")
      .send({ body: "cc @bob" });

    expect(res.status).toBe(201);
    expect(res.body.data.specKitArtifactName).toBe("spec.md");
    expect(res.body.data.comments).toHaveLength(1);
  });

  it("lists artifact threads", async () => {
    mockPrisma.commentThread.findMany.mockResolvedValue([]);
    const res = await request(app).get("/projects/proj-1/spec-kit/artifacts/spec.md/comments");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

// ---- IDOR guard — non-admin user cannot access threads in another project ---

describe("IDOR guard — project cross-access denied", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Switch to a non-admin user for this suite.
    Object.assign(testUser, { userId: "user-2", username: "bob", role: "developer" });
    // user-2 only owns proj-B, not proj-A.
    mockPrisma.project.findMany.mockResolvedValue([{ id: "proj-B" }]);
    app = createApp();
  });

  afterEach(() => {
    // Restore admin user for other suites.
    Object.assign(testUser, { userId: "user-1", username: "alice", role: "admin" });
  });

  it("denies non-admin reading threads in a project they do not own", async () => {
    // Requirement belongs to proj-A, which user-2 does not own.
    mockPrisma.requirement.findUnique.mockResolvedValue({ id: "req-1", projectId: "proj-A" });

    const res = await request(app).get("/requirements/req-1/comments");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("allows non-admin reading threads in a project they own", async () => {
    // Requirement belongs to proj-B, which user-2 does own.
    mockPrisma.requirement.findUnique.mockResolvedValue({ id: "req-2", projectId: "proj-B" });
    mockPrisma.commentThread.findMany.mockResolvedValue([]);

    const res = await request(app).get("/requirements/req-2/comments");

    expect(res.status).toBe(200);
  });
});
