/**
 * Issue #288 — repo-service: local/upload create + ingest-root resolution.
 *
 * Proves: createUploadRepoConnector stores + extracts an archive; a local
 * connector's create validates against the allowlist; resolveNonGitIngestRoot
 * re-extracts an upload archive and re-validates a local path (skips clone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

interface Row {
  id: string;
  projectId: string;
  label: string;
  provider: string;
  ownerOrOrg: string | null;
  repoName: string | null;
  localPath: string | null;
  uploadPath: string | null;
  isPrimary: boolean;
  deletedAt: Date | null;
  [k: string]: unknown;
}
const rows = new Map<string, Row>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    repoConnection: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const r of rows.values()) {
          if (r.deletedAt) continue;
          let ok = true;
          for (const [k, v] of Object.entries(where)) {
            if (k === "deletedAt") continue;
            if (r[k] !== v) ok = false;
          }
          if (ok) return r;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        nextId += 1;
        const row: Row = {
          id: `repo_${nextId}`,
          ownerOrOrg: null,
          repoName: null,
          localPath: null,
          uploadPath: null,
          isPrimary: false,
          deletedAt: null,
          ...(data as Row),
        };
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.get(where.id)!;
        const next = { ...r, ...data };
        rows.set(where.id, next);
        return next;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.delete(where.id);
        return {};
      }),
      count: vi.fn(async () => [...rows.values()].filter((r) => !r.deletedAt).length),
    },
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/vault/vault-service.js", () => ({ getVaultService: vi.fn() }));

import {
  createRepoConnector,
  createUploadRepoConnector,
  getRepoConnector,
  resolveNonGitIngestRoot,
} from "../src/lib/connectors/repo/repo-service.js";
import { LOCAL_SOURCE_ROOTS_ENV } from "../src/lib/connectors/repo/local-source.js";

let tmp: string;
let allowedDir: string;

beforeEach(async () => {
  rows.clear();
  nextId = 0;
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-nongit-")));
  allowedDir = path.join(tmp, "code");
  await fs.mkdir(allowedDir, { recursive: true });
  await fs.writeFile(path.join(allowedDir, "x.ts"), "export const x = 1;\n");
  process.env.UPLOAD_EXTRACT_DIR = path.join(tmp, "extracts");
  process.env.UPLOAD_ARCHIVE_DIR = path.join(tmp, "archives");
  process.env[LOCAL_SOURCE_ROOTS_ENV] = tmp;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env.UPLOAD_EXTRACT_DIR;
  delete process.env.UPLOAD_ARCHIVE_DIR;
  delete process.env[LOCAL_SOURCE_ROOTS_ENV];
  vi.clearAllMocks();
});

async function zipBuf(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("src/main.ts", "export const main = 1;\n");
  zip.file("notes.txt", "ignored\n");
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("createRepoConnector (provider=local)", () => {
  it("validates the path against the allowlist and stores its realpath", async () => {
    const created = await createRepoConnector(
      "proj_1",
      { label: "mounted", provider: "local", localPath: allowedDir },
      "user_1",
    );
    expect(created.provider).toBe("local");
    // Issue #288 / OWASP A01 — the read DTO must NOT echo the raw server path.
    expect(created).not.toHaveProperty("localPath");
    expect((created as Record<string, unknown>).localPath).toBeUndefined();
    expect(created.hasLocalSource).toBe(true);
    expect(created.ownerOrOrg).toBeNull();
  });

  it("redacts the raw server path from the read DTO for a connector.read caller (#288)", async () => {
    const created = await createRepoConnector(
      "proj_1",
      { label: "mounted", provider: "local", localPath: allowedDir },
      "user_1",
    );
    // getRepoConnector backs GET /repos/:id (gated on connector.read).
    const dto = await getRepoConnector("proj_1", created.id);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain(allowedDir);
    expect(serialized).not.toContain("localPath");
    expect(serialized).not.toContain("uploadPath");
    expect(dto.hasLocalSource).toBe(true);
    expect(dto.hasUploadArchive).toBe(false);
  });

  it("rejects a path outside the allowlist", async () => {
    await expect(
      createRepoConnector(
        "proj_1",
        { label: "evil", provider: "local", localPath: "/etc" },
        "user_1",
      ),
    ).rejects.toMatchObject({ code: "LOCAL_PATH_FORBIDDEN" });
  });
});

describe("createUploadRepoConnector + resolveNonGitIngestRoot", () => {
  it("stores + extracts an uploaded archive, then re-extracts on ingest", async () => {
    const buf = await zipBuf();
    const created = await createUploadRepoConnector("proj_1", "dropzone", buf, "user_1");
    expect(created.provider).toBe("upload");
    // Issue #288 / OWASP A01 — the archive path is redacted; only a flag leaks.
    expect((created as Record<string, unknown>).uploadPath).toBeUndefined();
    expect(created.hasUploadArchive).toBe(true);

    // resolveNonGitIngestRoot re-extracts from the stored archive (skip clone).
    const root = await resolveNonGitIngestRoot("proj_1", created.id);
    const main = await fs.readFile(path.join(root.path, "src/main.ts"), "utf-8");
    expect(main).toContain("export const main = 1;");
    // .txt is filtered out by SOURCE_EXTENSIONS.
    await expect(fs.access(path.join(root.path, "notes.txt"))).rejects.toBeTruthy();
  });

  it("rolls back the connector row if the archive is invalid", async () => {
    await expect(
      createUploadRepoConnector("proj_1", "bad", Buffer.from("not a zip"), "user_1"),
    ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
    expect([...rows.values()].length).toBe(0);
  });

  it("resolveNonGitIngestRoot for a local connector returns realpath + boundary", async () => {
    const created = await createRepoConnector(
      "proj_1",
      { label: "mounted", provider: "local", localPath: allowedDir },
      "user_1",
    );
    const root = await resolveNonGitIngestRoot("proj_1", created.id);
    expect(root.path).toBe(allowedDir);
    expect(root.boundary).toBe(allowedDir);
  });
});
