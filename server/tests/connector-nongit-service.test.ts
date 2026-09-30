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
const repoLog = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../src/lib/logger.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/logger.js")>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      return name === "repo-service" ? { ...real, ...repoLog } : real;
    },
  };
});
vi.mock("../src/lib/vault/vault-service.js", () => ({ getVaultService: vi.fn() }));

import {
  createRepoConnector,
  createUploadRepoConnector,
  deleteRepoConnector,
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

  it("#463 — an invalid archive is rejected before any insert and leaves no file", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    await expect(
      createUploadRepoConnector("proj_1", "bad", Buffer.from("not a zip"), "user_1"),
    ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
    expect(prisma.repoConnection.create).not.toHaveBeenCalled();
    expect(prisma.repoConnection.count).not.toHaveBeenCalled();
    const archives = await fs.readdir(process.env.UPLOAD_ARCHIVE_DIR!).catch(() => []);
    expect(archives).toEqual([]);
  });

  it("#463 — a failed insert removes the stored archive and the extraction", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    vi.mocked(prisma.repoConnection.create).mockRejectedValueOnce(new Error("db down"));
    await expect(
      createUploadRepoConnector("proj_1", "one", await zipBuf(), "user_1"),
    ).rejects.toThrow("db down");
    const [[arg]] = vi.mocked(prisma.repoConnection.create).mock.calls;
    expect(arg.data.uploadPath).toBe(
      path.join(process.env.UPLOAD_ARCHIVE_DIR!, `${String(arg.data.id)}.zip`),
    );
    expect(await fs.readdir(process.env.UPLOAD_ARCHIVE_DIR!)).toEqual([]);
    expect(await fs.readdir(process.env.UPLOAD_EXTRACT_DIR!).catch(() => [])).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it("#463 — the id is server-generated, lowercase alphanumeric", async () => {
    const created = await createUploadRepoConnector("proj_1", "one", await zipBuf(), "user_1");
    expect(created.id).toMatch(/^[a-z0-9]+$/);
    expect(rows.get(created.id)?.uploadPath).toBe(
      path.join(process.env.UPLOAD_ARCHIVE_DIR!, `${created.id}.zip`),
    );
  });

  it("#457 — writes isPrimary with the insert, never with a separate update", async () => {
    // A separate isPrimary update after the row exists could throw and leave an
    // upload connector behind while the caller is told the create failed.
    const { prisma } = await import("../src/lib/prisma.js");
    const first = await createUploadRepoConnector("proj_1", "one", await zipBuf(), "user_1");
    const second = await createUploadRepoConnector("proj_1", "two", await zipBuf(), "user_1");

    const creates = vi.mocked(prisma.repoConnection.create).mock.calls;
    expect(creates.map(([arg]) => arg.data.isPrimary)).toEqual([true, false]);
    for (const [arg] of vi.mocked(prisma.repoConnection.update).mock.calls) {
      expect(arg.data).not.toHaveProperty("isPrimary");
    }
    expect(first.isPrimary).toBe(true);
    expect(second.isPrimary).toBe(false);
    // Read back through the store, not the returned object.
    expect(rows.get(first.id)?.isPrimary).toBe(true);
    expect(rows.get(second.id)?.isPrimary).toBe(false);
  });

  it("#475 — a label clash the pre-check cannot see is a 409, and leaves no archive", async () => {
    // `@@unique([projectId, label])` also covers soft-deleted rows, which the
    // live-row pre-check skips; the insert's P2002 is the only signal.
    const { prisma } = await import("../src/lib/prisma.js");
    vi.mocked(prisma.repoConnection.create).mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: "repo_connections_projectId_label_key" },
      }),
    );
    await expect(
      createUploadRepoConnector("proj_1", "old", await zipBuf(), "user_1"),
    ).rejects.toMatchObject({ status: 409, code: "REPO_LABEL_TAKEN" });
    expect(prisma.repoConnection.create).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(process.env.UPLOAD_ARCHIVE_DIR!)).toEqual([]);
  });

  it("#475 — deleting an upload connector removes its stored archive", async () => {
    const created = await createUploadRepoConnector("proj_1", "gone", await zipBuf(), "user_1");
    const archive = rows.get(created.id)!.uploadPath!;
    await expect(fs.access(archive)).resolves.toBeUndefined();

    await deleteRepoConnector("proj_1", created.id, "user_1");

    await expect(fs.access(archive)).rejects.toMatchObject({ code: "ENOENT" });
    expect(rows.get(created.id)?.deletedAt).toBeInstanceOf(Date);
  });

  it("#475 — deleting one upload connector leaves another's archive in place", async () => {
    const gone = await createUploadRepoConnector("proj_1", "gone", await zipBuf(), "user_1");
    const kept = await createUploadRepoConnector("proj_1", "kept", await zipBuf(), "user_1");
    await deleteRepoConnector("proj_1", gone.id, "user_1");
    expect(await fs.readdir(process.env.UPLOAD_ARCHIVE_DIR!)).toEqual([`${kept.id}.zip`]);
  });

  it("#492 — delete removes the archive at the stored path after the root moved", async () => {
    const created = await createUploadRepoConnector("proj_1", "moved", await zipBuf(), "user_1");
    const archive = rows.get(created.id)!.uploadPath!;
    process.env.UPLOAD_ARCHIVE_DIR = path.join(tmp, "archives-elsewhere");
    await fs.mkdir(process.env.UPLOAD_ARCHIVE_DIR, { recursive: true });
    // A same-named file under the CURRENT root is not this connector's archive.
    const decoy = path.join(process.env.UPLOAD_ARCHIVE_DIR, `${created.id}.zip`);
    await fs.writeFile(decoy, "decoy");

    await deleteRepoConnector("proj_1", created.id, "user_1");

    await expect(fs.access(archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(decoy, "utf8")).resolves.toBe("decoy");
    expect(repoLog.warn).not.toHaveBeenCalled();
  });

  it("#492 — delete removes the connector's extraction directory", async () => {
    const created = await createUploadRepoConnector("proj_1", "ext", await zipBuf(), "user_1");
    const { path: dir } = await resolveNonGitIngestRoot("proj_1", created.id);
    await expect(fs.access(dir)).resolves.toBeUndefined();

    await deleteRepoConnector("proj_1", created.id, "user_1");

    await expect(fs.access(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("#492 — delete logs when the stored archive is already gone", async () => {
    const created = await createUploadRepoConnector("proj_1", "gone2", await zipBuf(), "user_1");
    const uploadPath = rows.get(created.id)!.uploadPath!;
    await fs.rm(uploadPath);

    await expect(deleteRepoConnector("proj_1", created.id, "user_1")).resolves.toBeUndefined();

    expect(repoLog.warn).toHaveBeenCalledTimes(1);
    expect(repoLog.warn.mock.calls[0]?.[0]).toMatch(/no archive at its stored path/);
    expect(repoLog.warn.mock.calls[0]?.[1]).toEqual({ connectorId: created.id, uploadPath });
  });

  it("#475 — an archive that cannot be removed does not fail the delete", async () => {
    const created = await createUploadRepoConnector("proj_1", "stuck", await zipBuf(), "user_1");
    // A non-empty directory at the archive path makes the removal throw.
    const archive = rows.get(created.id)!.uploadPath!;
    await fs.rm(archive);
    await fs.mkdir(archive);
    await fs.writeFile(path.join(archive, "x"), "x");

    await expect(deleteRepoConnector("proj_1", created.id, "user_1")).resolves.toBeUndefined();
    expect(rows.get(created.id)?.deletedAt).toBeInstanceOf(Date);
    expect(repoLog.warn).toHaveBeenCalledTimes(1);
    expect(repoLog.warn.mock.calls[0]?.[0]).toMatch(/Failed to remove/);
  });

  it("#527 — a failed extraction cleanup on delete is logged at warn, not swallowed", async () => {
    const created = await createUploadRepoConnector("proj_1", "stuck2", await zipBuf(), "user_1");
    const extractionDir = path.join(process.env.UPLOAD_EXTRACT_DIR!, created.id);
    const realRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, opts) => {
      if (target === extractionDir) {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      return realRm(target, opts);
    });
    try {
      await expect(deleteRepoConnector("proj_1", created.id, "user_1")).resolves.toBeUndefined();
    } finally {
      rmSpy.mockRestore();
    }

    expect(rows.get(created.id)?.deletedAt).toBeInstanceOf(Date);
    expect(repoLog.warn).toHaveBeenCalledTimes(1);
    expect(repoLog.warn.mock.calls[0]?.[0]).toMatch(/Failed to remove .* extraction/);
    expect(repoLog.warn.mock.calls[0]?.[1]).toEqual({
      connectorId: created.id,
      error: "EBUSY: resource busy",
    });
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
