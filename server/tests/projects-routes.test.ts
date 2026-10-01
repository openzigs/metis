/**
 * Integration tests for projects + documents + retrieve routes (Phase 5).
 *
 * Strategy: mock prisma in-memory, log in as the seeded mock-provider admin
 * (`admin/password`) which has all permissions, then drive the routes with
 * supertest. Document deletion runs through the real knowledge service,
 * including its interactive transaction and source blob removal.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface MockProject {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  createdById: string;
  deletedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}
interface MockDocument {
  id: string;
  projectId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  checksum: string;
  uploadedById: string;
  uploadedAt: Date;
  status: string;
  errorMessage: string | null;
  chunkCount: number;
  processedAt: Date | null;
  deletedAt: Date | null;
}

const projects = new Map<string, MockProject>();
const documents = new Map<string, MockDocument>();
const quarantine = new Map<string, { id: string; documentId: string; ord: number }>();
let pNext = 0;
let dNext = 0;

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({
          id: "user_admin",
          ...create,
        }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        if (where.slug) {
          for (const p of projects.values()) if (p.slug === where.slug) return p;
          return null;
        }
        if (where.id) return projects.get(where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const p = projects.get(where.id);
        return p && !p.deletedAt ? p : null;
      }),
      findMany: vi.fn(async ({ take = 25, skip = 0 }: { take?: number; skip?: number }) =>
        [...projects.values()].filter((p) => !p.deletedAt).slice(skip, skip + take),
      ),
      count: vi.fn(async () => [...projects.values()].filter((p) => !p.deletedAt).length),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<
            MockProject,
            "id" | "createdAt" | "updatedAt" | "deletedAt" | "description"
          > & {
            description?: string;
          };
        }) => {
          pNext += 1;
          const row: MockProject = Object.assign(
            {
              id: `proj_aaaa${pNext}`,
              createdAt: new Date(),
              updatedAt: new Date(),
              deletedAt: null,
              description: "",
            },
            data,
          );
          projects.set(row.id, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<MockProject> }) => {
          const existing = projects.get(where.id);
          if (!existing) throw new Error("not found");
          const next = { ...existing, ...data, updatedAt: new Date() } as MockProject;
          projects.set(where.id, next);
          return next;
        },
      ),
    },
    document: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const d = documents.get(where.id);
        return d && !d.deletedAt ? d : null;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => documents.get(where.id) ?? null,
      ),
      findMany: vi.fn(
        async ({
          where,
          take = 25,
          skip = 0,
        }: {
          where: { projectId: string };
          take?: number;
          skip?: number;
        }) =>
          [...documents.values()]
            .filter((d) => d.projectId === where.projectId && !d.deletedAt)
            .slice(skip, skip + take),
      ),
      count: vi.fn(
        async ({ where }: { where: { projectId: string } }) =>
          [...documents.values()].filter((d) => d.projectId === where.projectId && !d.deletedAt)
            .length,
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<
            MockDocument,
            "id" | "uploadedAt" | "deletedAt" | "errorMessage" | "chunkCount" | "processedAt"
          >;
        }) => {
          dNext += 1;
          const row: MockDocument = {
            id: `doc_aaaa${dNext}`,
            uploadedAt: new Date(),
            deletedAt: null,
            errorMessage: null,
            chunkCount: 0,
            processedAt: null,
            ...data,
          };
          documents.set(row.id, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<MockDocument> }) => {
          const d = documents.get(where.id);
          if (!d) throw new Error("not found");
          const next = { ...d, ...data } as MockDocument;
          documents.set(where.id, next);
          return next;
        },
      ),
    },
    quarantineChunk: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { documentId: string; ord: { in: number[] } };
          data: { ord: number };
        }) => {
          let count = 0;
          for (const row of quarantine.values()) {
            if (row.documentId === where.documentId && where.ord.in.includes(row.ord)) {
              Object.assign(row, data);
              count += 1;
            }
          }
          return { count };
        },
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: { documentId: string; ord: { gte: number } } }) => {
          let count = 0;
          for (const [id, row] of quarantine) {
            if (row.documentId === where.documentId && row.ord >= where.ord.gte) {
              quarantine.delete(id);
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
    // #428 — the primary-repo link on POST /projects.
    repoConnection: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "repo_1",
        isPrimary: false,
        errorMessage: null,
        lastTestedAt: null,
        lastIngestAt: null,
        lastCommitSha: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ...data,
      })),
      // A new project has no repositories yet.
      count: vi.fn(async () => 0),
      update: vi.fn(async () => ({})),
    },
    knowledgeChunk: {
      create: vi.fn(async () => ({ id: "c", vectorRef: null })),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  });
  return { prisma };
});

import request from "supertest";
import { createApp } from "../src/app.js";
import { getDocumentStorage } from "../src/lib/documents/storage.js";
import { prisma } from "../src/lib/prisma.js";
import { ConnectorError } from "../src/lib/connectors/types.js";
import { __resetArchiveHooks } from "../src/lib/projects/project-service.js";

let app: ReturnType<typeof createApp>;
let token: string;
let storageRoot: string;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metis-routes-"));
  process.env.UPLOAD_DIR = storageRoot;
  process.env.LANCEDB_PATH = await fs.mkdtemp(path.join(os.tmpdir(), "metis-vec-"));
});

beforeEach(async () => {
  projects.clear();
  documents.clear();
  quarantine.clear();
  pNext = 0;
  dNext = 0;
  __resetArchiveHooks();
  app = createApp();
  token = await login();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/projects", () => {
  it("POST creates a project (201)", async () => {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Phase Five", slug: "p5" });
    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe("p5");
  });

  // #428 — a failed primary-repo link used to answer 201 with `primaryRepo: null`
  // and no reason, so the Create form reported plain success.
  it("POST links the primary repo and reports no link error (#428)", async () => {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Linked",
        slug: "linked",
        primaryRepo: { ownerOrOrg: "acme", repoName: "app" },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.primaryRepo).toMatchObject({ id: "repo_1", isPrimary: true });
    expect(res.body.data.primaryRepoError).toBeNull();
  });

  it("POST still creates the project but names why the primary repo was not linked (#428)", async () => {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Insecure",
        slug: "insecure",
        primaryRepo: {
          ownerOrOrg: "acme",
          repoName: "app",
          apiBaseUrl: "http://ghe.example.com/api/v3",
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe("insecure");
    expect(res.body.data.primaryRepo).toBeNull();
    expect(res.body.data.primaryRepoError).toEqual({
      code: "INSECURE_BASE_URL",
      message: "apiBaseUrl must use HTTPS: http://ghe.example.com/api/v3",
    });
    // The project really exists — read it back through the API.
    const got = await request(app)
      .get(`/api/projects/${res.body.data.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(got.status).toBe(200);
  });

  it("POST answers a generic link error, not the internal one, when the store throws (#428)", async () => {
    vi.mocked(prisma.repoConnection.create).mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 10.0.0.5:5432"),
    );
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Down", slug: "down", primaryRepo: { ownerOrOrg: "acme", repoName: "app" } });
    expect(res.status).toBe(201);
    expect(res.body.data.primaryRepo).toBeNull();
    expect(res.body.data.primaryRepoError.code).toBe("PRIMARY_REPO_LINK_FAILED");
    expect(res.body.data.primaryRepoError.message).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });

  it("POST sanitizes a driver-detail connector error so no host reaches the client (#428)", async () => {
    // PR #444 review: the isDriverDetailCode branch had no test. Its message is
    // network-derived and can carry an internal address.
    vi.mocked(prisma.repoConnection.create).mockRejectedValueOnce(
      new ConnectorError(400, "HOST_NOT_ALLOWED", "host 10.0.0.5 is not in the allow-list"),
    );
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Blocked",
        slug: "blocked",
        primaryRepo: { ownerOrOrg: "acme", repoName: "app" },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.primaryRepo).toBeNull();
    expect(res.body.data.primaryRepoError.code).toBe("HOST_NOT_ALLOWED");
    expect(res.body.data.primaryRepoError.message).not.toMatch(/10\.0\.0\.5/);
  });

  // #448 — createRepoConnector marks a project's first repository primary in
  // the insert itself, so the route no longer spends a second round-trip on it.
  it("POST links the primary repo without an isPrimary update of its own (#448)", async () => {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "One", slug: "one", primaryRepo: { ownerOrOrg: "acme", repoName: "app" } });
    expect(res.status).toBe(201);
    expect(res.body.data.primaryRepo).toMatchObject({ id: "repo_1", isPrimary: true });
    expect(prisma.repoConnection.update).not.toHaveBeenCalled();
  });

  it("POST omits a link error when no primary repo was requested (#428)", async () => {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Bare", slug: "bare" });
    expect(res.status).toBe(201);
    expect(res.body.data.primaryRepo).toBeNull();
    expect(res.body.data.primaryRepoError).toBeNull();
  });

  it("POST validates payload (400)", async () => {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "", slug: "Bad Slug" });
    expect(res.status).toBe(400);
  });

  it("GET / lists projects", async () => {
    await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "A", slug: "a" });
    const res = await request(app).get("/api/projects").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });

  it("GET /:id returns 404 for unknown", async () => {
    const res = await request(app)
      .get("/api/projects/unknown")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("PATCH updates a project", async () => {
    const create = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "A", slug: "a" });
    const id = create.body.data.id;
    const res = await request(app)
      .patch(`/api/projects/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "A2" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("A2");
  });

  it("POST /:id/archive transitions to archived", async () => {
    const create = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "A", slug: "a" });
    const id = create.body.data.id;
    const res = await request(app)
      .post(`/api/projects/${id}/archive`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("archived");
  });

  it("DELETE soft-deletes (204)", async () => {
    const create = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "A", slug: "a" });
    const id = create.body.data.id;
    const res = await request(app)
      .delete(`/api/projects/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(401);
  });

  it("rejects ?status=garbage", async () => {
    const res = await request(app)
      .get("/api/projects?status=garbage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("/api/projects/:id/documents", () => {
  async function newProject(slug = "docs"): Promise<string> {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: slug, slug });
    return res.body.data.id;
  }

  it("POST uploads a markdown file (201)", async () => {
    const id = await newProject();
    const res = await request(app)
      .post(`/api/projects/${id}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("# Hi\n\nbody"), {
        filename: "notes.md",
        contentType: "text/markdown",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.document.filename).toBe("notes.md");
  });

  it("POST without a file returns 400 FILE_REQUIRED", async () => {
    const id = await newProject("a");
    const res = await request(app)
      .post(`/api/projects/${id}/documents`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FILE_REQUIRED");
  });

  it("POST rejects disallowed MIME types (415)", async () => {
    const id = await newProject("b");
    const res = await request(app)
      .post(`/api/projects/${id}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("MZ"), {
        filename: "evil.exe",
        contentType: "application/x-msdownload",
      });
    expect(res.status).toBe(415);
  });

  it("POST refuses uploads to archived projects (409)", async () => {
    const id = await newProject("c");
    await request(app).post(`/api/projects/${id}/archive`).set("Authorization", `Bearer ${token}`);
    const res = await request(app)
      .post(`/api/projects/${id}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("# x"), {
        filename: "n.md",
        contentType: "text/markdown",
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROJECT_ARCHIVED");
  });

  it("GET / lists project documents", async () => {
    const id = await newProject("d");
    await request(app)
      .post(`/api/projects/${id}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("# a"), {
        filename: "a.md",
        contentType: "text/markdown",
      });
    const res = await request(app)
      .get(`/api/projects/${id}/documents`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(1);
  });

  it("GET /:documentId returns 404 for unknown", async () => {
    const id = await newProject("e");
    const res = await request(app)
      .get(`/api/projects/${id}/documents/nope`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("DELETE /:documentId returns 204", async () => {
    const id = await newProject("f");
    const upload = await request(app)
      .post(`/api/projects/${id}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("# x"), {
        filename: "x.md",
        contentType: "text/markdown",
      });
    expect(upload.status).toBe(201);
    const docId = upload.body.data.document.id;
    const sourcePath = documents.get(docId)!.storagePath;
    expect(await getDocumentStorage().read(sourcePath)).toEqual(Buffer.from("# x"));
    const ordinals = [-4, -3, -2, -1, 0, 1];
    for (const ord of ordinals) {
      for (const documentId of [docId, "doc_other"]) {
        const chunkId = `${documentId}:${ord}`;
        quarantine.set(chunkId, { id: chunkId, documentId, ord });
      }
    }
    const res = await request(app)
      .delete(`/api/projects/${id}/documents/${docId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(documents.get(docId)).toMatchObject({
      deletedAt: expect.any(Date),
      status: "failed",
      errorMessage: "deleted",
      chunkCount: 0,
    });
    // Retain revoked journals so in-flight workers can reconcile; remove only payload rows.
    expect([...quarantine.values()].filter((row) => row.documentId === docId)).toEqual(
      [-4, -3, -2, -1].map((ord) => ({ id: `${docId}:${ord}`, documentId: docId, ord: -1 })),
    );
    expect([...quarantine.values()].filter((row) => row.documentId === "doc_other")).toEqual(
      ordinals.map((ord) => ({ id: `doc_other:${ord}`, documentId: "doc_other", ord })),
    );
    expect(prisma.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: docId },
    });
    expect(await getDocumentStorage().exists(sourcePath)).toBe(false);
    const deleted = await request(app)
      .get(`/api/projects/${id}/documents/${docId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(404);
  });
});

describe("/api/projects/:id/retrieve", () => {
  async function newProject(slug = "ret"): Promise<string> {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: slug, slug });
    return res.body.data.id;
  }

  it("POST validates the payload", async () => {
    const id = await newProject();
    const res = await request(app)
      .post(`/api/projects/${id}/retrieve`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("POST returns hits array for a valid query", async () => {
    const id = await newProject("ret2");
    // Upload one doc so search has something to work with.
    await request(app)
      .post(`/api/projects/${id}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("# t\n\nthe quick brown fox"), {
        filename: "n.md",
        contentType: "text/markdown",
      });
    const res = await request(app)
      .post(`/api/projects/${id}/retrieve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "fox", k: 3 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.hits)).toBe(true);
  });

  it("POST 404s for unknown project", async () => {
    const res = await request(app)
      .post("/api/projects/nope/retrieve")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "x" });
    expect(res.status).toBe(404);
  });
});
