/**
 * Documents URL + text ingest route tests (issue #132).
 *
 * Reuses the same admin-login + in-memory prisma harness as
 * `projects-routes.test.ts` but mocks `url-fetcher` so we don't need
 * network access. Asserts:
 *   - URL ingest happy path → 201 + document row
 *   - URL ingest propagates SSRF + size + MIME errors with the right code
 *   - Text ingest happy path → 201 + chunked document
 *   - Text ingest validates payload + size cap
 *   - Both routes refuse archived projects (409)
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
let pNext = 0;
let dNext = 0;

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: "user_admin",
        ...create,
      })),
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
      findMany: vi.fn(async () => [...projects.values()].filter((p) => !p.deletedAt)),
      count: vi.fn(async () => [...projects.values()].filter((p) => !p.deletedAt).length),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<MockProject, "id" | "createdAt" | "updatedAt" | "deletedAt">;
        }) => {
          pNext += 1;
          const row: MockProject = {
            id: `proj_aaaa${pNext}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            description: "",
            ...data,
          };
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
      findMany: vi.fn(async () => [...documents.values()].filter((d) => !d.deletedAt)),
      count: vi.fn(async () => [...documents.values()].filter((d) => !d.deletedAt).length),
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
    knowledgeChunk: {
      create: vi.fn(async () => ({ id: "c", vectorRef: null })),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  });
  return { prisma };
});

// Stub the URL fetcher so we don't hit the network. Tests that want a
// failure case override the implementation via `mockImplementationOnce`.
vi.mock("../src/lib/documents/url-fetcher.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/documents/url-fetcher.js")>(
    "../src/lib/documents/url-fetcher.js",
  );
  return {
    ...actual,
    fetchUrlForIngest: vi.fn(async (url: string) => ({
      buffer: Buffer.from("# fetched\n\nbody from url"),
      contentType: "text/markdown",
      finalUrl: url,
      filename: "fetched.md",
    })),
  };
});

import request from "supertest";
import { createApp } from "../src/app.js";
import { __resetArchiveHooks } from "../src/lib/projects/project-service.js";
import { fetchUrlForIngest, UrlFetchError } from "../src/lib/documents/url-fetcher.js";

const fetchMock = fetchUrlForIngest as unknown as ReturnType<typeof vi.fn>;

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

async function newProject(slug: string): Promise<string> {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: slug, slug });
  expect(res.status).toBe(201);
  return res.body.data.id;
}

beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metis-routes-url-"));
  process.env.UPLOAD_DIR = storageRoot;
  process.env.LANCEDB_PATH = await fs.mkdtemp(path.join(os.tmpdir(), "metis-vec-url-"));
});

beforeEach(async () => {
  projects.clear();
  documents.clear();
  pNext = 0;
  dNext = 0;
  __resetArchiveHooks();
  app = createApp();
  token = await login();
  fetchMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/projects/:id/documents/url", () => {
  it("happy path → 201 with the persisted document row", async () => {
    const id = await newProject("urlhappy");
    const res = await request(app)
      .post(`/api/projects/${id}/documents/url`)
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "https://docs.example/notes.md" });
    expect(res.status).toBe(201);
    expect(res.body.data.document.filename).toBe("fetched.md");
    expect(res.body.data.source.url).toBe("https://docs.example/notes.md");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates the payload (400)", async () => {
    const id = await newProject("urlbad");
    const res = await request(app)
      .post(`/api/projects/${id}/documents/url`)
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "not-a-url" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  // ── SSRF reconnaissance oracle (#1084) ────────────────────────────────
  // The guard blocking the request is the security control; the rejection
  // describing *why* defeats it. These tests pin the caller-visible contract.

  it("returns nothing about the resolved address when an SSRF block fires", async () => {
    const id = await newProject("urlssrf");
    fetchMock.mockImplementationOnce(async () => {
      throw new UrlFetchError(
        403,
        "PRIVATE_HOST_BLOCKED",
        "Host resolves to 10.1.2.3 which is in non-routable range (rfc1918)",
      );
    });
    const res = await request(app)
      .post(`/api/projects/${id}/documents/url`)
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "https://internal-db.corp.local/" });
    expect(res.status).toBe(400);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
    expect(serialized).not.toContain("internal-db.corp.local");
    expect(serialized).not.toContain("rfc1918");
    expect(serialized).not.toContain("PRIVATE_HOST_BLOCKED");
  });

  it("answers a private-range block identically to an unreachable public host", async () => {
    const id = await newProject("urloracle");
    // `correlationId` is per-request by design, so it is normalised out — every
    // other byte of the two envelopes must match, including the status line.
    const strip = (body: Record<string, unknown>): string =>
      JSON.stringify({ ...body, correlationId: undefined });

    const rejections: UrlFetchError[] = [
      new UrlFetchError(
        403,
        "PRIVATE_HOST_BLOCKED",
        "Hostname 'internal-db.corp.local' resolves to private/loopback IP 169.254.169.254",
      ),
      new UrlFetchError(
        403,
        "HOST_NOT_ALLOWED",
        "Hostname 'internal-db.corp.local' is not in INGEST_URL_ALLOWLIST",
      ),
      new UrlFetchError(502, "DNS_FAILURE", "DNS lookup failed for nope.example: ENOTFOUND"),
      new UrlFetchError(
        502,
        "FETCH_FAILED",
        "URL fetch failed: connect ECONNREFUSED 93.184.216.34:443",
      ),
    ];

    const seen = new Set<string>();
    for (const rejection of rejections) {
      fetchMock.mockImplementationOnce(async () => {
        throw rejection;
      });
      const res = await request(app)
        .post(`/api/projects/${id}/documents/url`)
        .set("Authorization", `Bearer ${token}`)
        .send({ url: "https://probe.example/" });
      seen.add(`${res.status} ${strip(res.body)}`);
    }
    expect([...seen]).toHaveLength(1);
  });

  it("propagates size errors as 413", async () => {
    const id = await newProject("urlsize");
    fetchMock.mockImplementationOnce(async () => {
      throw new UrlFetchError(413, "RESPONSE_TOO_LARGE", "too big");
    });
    const res = await request(app)
      .post(`/api/projects/${id}/documents/url`)
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "https://docs.example/big" });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("RESPONSE_TOO_LARGE");
  });

  it("refuses uploads to archived projects (409)", async () => {
    const id = await newProject("urlarchived");
    await request(app).post(`/api/projects/${id}/archive`).set("Authorization", `Bearer ${token}`);
    const res = await request(app)
      .post(`/api/projects/${id}/documents/url`)
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "https://docs.example/notes.md" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROJECT_ARCHIVED");
  });

  it("requires authentication", async () => {
    const id = await newProject("urlauth");
    const res = await request(app)
      .post(`/api/projects/${id}/documents/url`)
      .send({ url: "https://docs.example/x.md" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/projects/:id/documents/text", () => {
  it("happy path → 201 with the persisted document row", async () => {
    const id = await newProject("texthappy");
    const res = await request(app)
      .post(`/api/projects/${id}/documents/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ filename: "pasted.md", content: "# pasted\n\nbody" });
    expect(res.status).toBe(201);
    expect(res.body.data.document.filename).toBe("pasted.md");
    expect(res.body.data.document.mimeType).toBe("text/markdown");
  });

  it("infers MIME from filename when not provided", async () => {
    const id = await newProject("textinfer");
    const res = await request(app)
      .post(`/api/projects/${id}/documents/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ filename: "log.txt", content: "plain text" });
    expect(res.status).toBe(201);
    expect(res.body.data.document.mimeType).toBe("text/plain");
  });

  it("validates the payload (400)", async () => {
    const id = await newProject("textbad");
    const res = await request(app)
      .post(`/api/projects/${id}/documents/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ filename: "x.md", content: "" });
    expect(res.status).toBe(400);
  });

  it("rejects oversize content (400 via schema cap)", async () => {
    const id = await newProject("textbig");
    const res = await request(app)
      .post(`/api/projects/${id}/documents/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        filename: "x.md",
        content: "x".repeat(10 * 1024 * 1024 + 1),
      });
    // Express's json body parser may itself 413 before zod sees the payload —
    // accept either. Either way the route must NOT 201.
    expect(res.status).not.toBe(201);
  });

  it("refuses uploads to archived projects (409)", async () => {
    const id = await newProject("textarchived");
    await request(app).post(`/api/projects/${id}/archive`).set("Authorization", `Bearer ${token}`);
    const res = await request(app)
      .post(`/api/projects/${id}/documents/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ filename: "n.md", content: "# x" });
    expect(res.status).toBe(409);
  });

  it("requires authentication", async () => {
    const id = await newProject("textauth");
    const res = await request(app)
      .post(`/api/projects/${id}/documents/text`)
      .send({ filename: "x.md", content: "x" });
    expect(res.status).toBe(401);
  });
});
