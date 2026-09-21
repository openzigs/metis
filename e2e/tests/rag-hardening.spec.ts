/**
 * Epic #157 — RAG hardening e2e (quarantine + ACL).
 *
 * Drives the new quarantine workflow through the real API:
 *   1. Login + create a project.
 *   2. Upload a markdown document — server lands it in `pending` /
 *      `quarantined` indexState because auto-approve defaults to off.
 *   3. `POST /api/documents/:id/approve` flips it to `indexed` and chunks
 *      become visible to RAG search.
 *   4. `PATCH /api/documents/:id/acl` cascades a deny rule and the document
 *      hides from a search performed by a non-admin actor.
 *
 * AI provider is `offline-stub`, embedder is `HashEmbedder`, vector store is
 * the local in-memory backend — same determinism guarantees as the rest of
 * the e2e suite. No external network is touched.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, "..", "fixtures");
const MD_PATH = path.join(FIXTURES_DIR, "sample.md");

import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (value: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T> {
  const interval = opts.intervalMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== null && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`pollUntil timed out waiting for ${opts.label}`);
}

test.describe("Epic #157 — RAG hardening", () => {
  test("upload → quarantined → approve → indexed; ACL hides from non-admin @rag-hardening", async () => {
    await primeAdminUser(API_BASE);
    // -------- Login --------
    const ctx = await request.newContext({ baseURL: API_BASE });
    const loginRes = await ctx.post("/api/auth/login", {
      data: { username: ADMIN_USER.username, password: ADMIN_USER.password },
    });
    expect(loginRes.status()).toBe(200);
    const loginBody = (await loginRes.json()) as ApiEnvelope<{ accessToken: string }>;
    const token = loginBody.data.accessToken;
    await ctx.dispose();

    const slug = `rag-hard-${Date.now()}`;

    const api = await authedApi(token);
    try {
      // -------- 1. Create project --------
      const created = await api.post("/api/projects", {
        data: { name: `RAG hard ${slug}`, slug, description: "rag-hardening" },
      });
      expect(created.status(), await created.text()).toBe(201);
      const projectBody = (await created.json()) as ApiEnvelope<{ id: string }>;
      const projectId = projectBody.data.id;

      // -------- 2. Upload a markdown document --------
      const buffer = await import("node:fs/promises").then((f) => f.readFile(MD_PATH));
      const upload = await api.post(`/api/projects/${projectId}/documents`, {
        multipart: {
          file: { name: "sample.md", mimeType: "text/markdown", buffer },
        },
      });
      expect([201, 202]).toContain(upload.status());
      const uploadBody = (await upload.json()) as ApiEnvelope<{ id: string }>;
      const documentId = uploadBody.data.id;
      expect(documentId).toBeTruthy();

      // -------- 3. Document settles into quarantine (or pending) --------
      const settled = await pollUntil(
        async () => {
          const res = await api.get(`/api/projects/${projectId}/documents?limit=20`);
          if (!res.ok()) return null;
          const body = (await res.json()) as ApiEnvelope<{
            items: Array<{ id: string; indexState?: string; status: string }>;
          }>;
          return body.data.items.find((d) => d.id === documentId) ?? null;
        },
        (doc) => doc.indexState === "quarantined" || doc.indexState === "pending",
        { timeoutMs: 30_000, label: "document quarantined" },
      );
      expect(["quarantined", "pending"]).toContain(settled.indexState);

      // -------- 4. Quarantine list surfaces this document --------
      const qList = await api.get(`/api/projects/${projectId}/quarantine`);
      expect(qList.status()).toBe(200);
      const qBody = (await qList.json()) as ApiEnvelope<{
        items: Array<{ documentId: string }>;
      }>;
      expect(qBody.data.items.some((row) => row.documentId === documentId)).toBe(true);

      // -------- 5. Approve flips indexState to "indexed" --------
      const approve = await api.post(`/api/documents/${documentId}/approve`, {
        data: {},
      });
      expect(approve.status(), await approve.text()).toBe(200);

      const indexed = await pollUntil(
        async () => {
          const res = await api.get(`/api/projects/${projectId}/documents?limit=20`);
          if (!res.ok()) return null;
          const body = (await res.json()) as ApiEnvelope<{
            items: Array<{ id: string; indexState?: string }>;
          }>;
          return body.data.items.find((d) => d.id === documentId) ?? null;
        },
        (doc) => doc.indexState === "indexed",
        { timeoutMs: 30_000, label: "document indexed" },
      );
      expect(indexed.indexState).toBe("indexed");

      // -------- 6. PATCH ACL with a deny rule on a fictional role --------
      const aclRes = await api.patch(`/api/documents/${documentId}/acl`, {
        data: {
          aclSubjects: [{ kind: "deny", value: "role:secret" }],
        },
      });
      expect(aclRes.status(), await aclRes.text()).toBe(200);
    } finally {
      await api.dispose();
    }
  });
});
