/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #396 (MVP-7) — installer + path-guard + per-host emitter tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const featureRows = new Map<string, any>();
const featureArtifactRows = new Map<string, any>();
const artifactRows = new Map<string, any>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    specKitFeature: {
      findMany: vi.fn(async ({ where }: any) =>
        [...featureRows.values()].filter((r) => r.projectId === where.projectId),
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.projectId_slug) {
          for (const r of featureRows.values()) {
            if (
              r.projectId === where.projectId_slug.projectId &&
              r.slug === where.projectId_slug.slug
            )
              return r;
          }
        }
        return null;
      }),
    },
    specKitFeatureArtifact: {
      findMany: vi.fn(async ({ where }: any) =>
        [...featureArtifactRows.values()].filter((r) => r.featureId === where.featureId),
      ),
    },
    specKitArtifact: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.projectId_name) {
          for (const r of artifactRows.values()) {
            if (
              r.projectId === where.projectId_name.projectId &&
              r.name === where.projectId_name.name
            )
              return r;
          }
        }
        return null;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import { resolveAttached } from "../src/lib/spec-kit/installer/path-guard.js";
import { buildPromptBody, emitHostFiles, HOSTS } from "../src/lib/spec-kit/installer/hosts.js";
import { runInstall, planInstall } from "../src/lib/spec-kit/installer/index.js";

beforeEach(() => {
  featureRows.clear();
  featureArtifactRows.clear();
  artifactRows.clear();
  // Allowlist used in the installer tests below.
  process.env.METIS_PUBLIC_URL = "https://metis.local";
  process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS = "https://metis.local";
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env.METIS_PUBLIC_URL;
  delete process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS;
});

function seedFeature(projectId: string, slug: string): string {
  const id = `f_${slug}`;
  featureRows.set(id, {
    id,
    projectId,
    slug,
    title: slug,
    status: "draft",
    branchName: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function seedArtifact(featureId: string, key: string, content: string): void {
  const id = `fa_${featureId}_${key}`;
  featureArtifactRows.set(id, {
    id,
    featureId,
    key,
    content,
    version: 1,
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("resolveAttached (path-guard)", () => {
  it("accepts a relative path inside the workspace", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-pg-"));
    try {
      const real = await fs.realpath(tmp);
      expect(await resolveAttached({ workspaceRoot: tmp, target: ".specify/foo" })).toBe(
        path.join(real, ".specify/foo"),
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects '..' segments", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-pg-"));
    try {
      await expect(resolveAttached({ workspaceRoot: tmp, target: "../escape" })).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an absolute path outside the workspace", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-pg-"));
    try {
      await expect(
        resolveAttached({ workspaceRoot: tmp, target: "/etc/passwd" }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("accepts an absolute path inside the workspace", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-pg-"));
    try {
      const real = await fs.realpath(tmp);
      const abs = path.join(real, "specs/001-foo/spec.md");
      expect(await resolveAttached({ workspaceRoot: tmp, target: abs })).toBe(abs);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("accepts a regular file under the workspace", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-pg-"));
    try {
      await fs.mkdir(path.join(tmp, "sub"), { recursive: true });
      await fs.writeFile(path.join(tmp, "sub/file.txt"), "x");
      const out = await resolveAttached({ workspaceRoot: tmp, target: "sub/file.txt" });
      const real = await fs.realpath(tmp);
      expect(out).toBe(path.join(real, "sub/file.txt"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a symlink under the workspace pointing outside it", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-pg-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-outside-"));
    try {
      // Create a symlink inside tmp that points outside.
      await fs.symlink(outside, path.join(tmp, "escape"));
      // The lexical check would have passed ("escape/file" is under tmp);
      // realpath catches the bypass.
      await expect(
        resolveAttached({ workspaceRoot: tmp, target: "escape/file.md" }),
      ).rejects.toMatchObject({ code: "PATH_NOT_ATTACHED" });
      await expect(resolveAttached({ workspaceRoot: tmp, target: "escape" })).rejects.toMatchObject(
        { code: "PATH_NOT_ATTACHED" },
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("buildPromptBody / emitHostFiles", () => {
  it("includes the METIS REST endpoint in every prompt", () => {
    const body = buildPromptBody("speckit.specify", {
      projectId: "p1",
      apiBaseUrl: "https://metis.local",
    });
    expect(body).toContain(
      "POST https://metis.local/api/projects/p1/spec-kit/commands/speckit.specify",
    );
    expect(body).toContain("# /speckit.specify");
  });

  it("emits one file per command for each host with the right path/extension", () => {
    for (const host of HOSTS) {
      const files = emitHostFiles(host, { projectId: "p1", apiBaseUrl: "https://metis.local" });
      expect(files.length).toBeGreaterThanOrEqual(9);
      const first = files[0]!;
      // Issue #432 — codex uses `.codex/skills/speckit/speckit-<cmd>.md`;
      // every other host uses `.<host>/(prompts|commands)/speckit.<cmd>.<ext>`.
      if (host === "codex") {
        expect(first.relPath).toMatch(/^\.codex\/skills\/speckit\/speckit-[a-z]+\.md$/);
      } else {
        expect(first.relPath).toMatch(/^[.][a-z]+\/(prompts|commands)\/speckit\..+/);
      }
      if (host === "copilot") expect(first.relPath.endsWith(".prompt.md")).toBe(true);
      else expect(first.relPath.endsWith(".md")).toBe(true);
    }
  });
});

describe("runInstall (dryRun)", () => {
  it("rejects when consent is false", async () => {
    await expect(
      runInstall({
        projectId: "p1",
        workspaceRoot: "/tmp/ws",
        hosts: ["copilot"],
        apiBaseUrl: "https://metis.local",
        consent: false as any,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ status: 400, code: "SPECKIT_CONSENT_REQUIRED" });
  });

  it("rejects when hosts is empty", async () => {
    await expect(
      runInstall({
        projectId: "p1",
        workspaceRoot: "/tmp/ws",
        hosts: [],
        apiBaseUrl: "https://metis.local",
        consent: true,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "SPECKIT_HOSTS_REQUIRED" });
  });

  it("rejects unknown host keys", async () => {
    await expect(
      runInstall({
        projectId: "p1",
        workspaceRoot: "/tmp/ws",
        hosts: ["bogus" as any],
        apiBaseUrl: "https://metis.local",
        consent: true,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "SPECKIT_INVALID_HOST" });
  });

  it("emits multi-host install file set in dry-run", async () => {
    const fid = seedFeature("p1", "001-build");
    seedArtifact(fid, "spec.md", "Spec");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-dry-"));
    try {
      const result = await runInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["copilot", "claude", "cursor", "pi"],
        apiBaseUrl: "https://metis.local",
        consent: true,
        dryRun: true,
      });
      expect(result.featureCount).toBe(1);
      expect(result.hosts).toEqual(["copilot", "claude", "cursor", "pi"]);
      expect(result.files.some((f) => f.relPath === "specs/001-build/spec.md")).toBe(true);
      expect(result.files.some((f) => f.relPath === "specs/001-build/status.json")).toBe(true);
      expect(result.files.some((f) => f.relPath.startsWith(".github/prompts/"))).toBe(true);
      expect(result.files.some((f) => f.relPath.startsWith(".claude/commands/"))).toBe(true);
      expect(result.files.some((f) => f.relPath.startsWith(".cursor/commands/"))).toBe(true);
      expect(result.files.some((f) => f.relPath.startsWith(".pi/prompts/"))).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("emits codex skill files + AGENTS.md when --ai codex is requested", async () => {
    const fid = seedFeature("p1", "001-build");
    seedArtifact(fid, "spec.md", "Spec");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-codex-"));
    try {
      const result = await runInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["codex"],
        apiBaseUrl: "https://metis.local",
        consent: true,
        dryRun: true,
      });
      expect(result.files.some((f) => f.relPath === "AGENTS.md")).toBe(true);
      expect(
        result.files.some((f) => f.relPath === ".codex/skills/speckit/speckit-specify.md"),
      ).toBe(true);
      const agents = result.files.find((f) => f.relPath === "AGENTS.md")!;
      expect(agents.content).toContain("$speckit-specify");
      expect(agents.content).toContain("<!-- speckit:start -->");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("multi-host install with copilot+codex emits both surfaces", async () => {
    const fid = seedFeature("p1", "001-build");
    seedArtifact(fid, "spec.md", "Spec");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-multi-"));
    try {
      const result = await runInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["copilot", "codex"],
        apiBaseUrl: "https://metis.local",
        consent: true,
        dryRun: true,
      });
      expect(result.files.some((f) => f.relPath.startsWith(".github/prompts/"))).toBe(true);
      expect(result.files.some((f) => f.relPath.startsWith(".codex/skills/speckit/"))).toBe(true);
      expect(result.files.some((f) => f.relPath === "AGENTS.md")).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("merges into existing AGENTS.md preserving prose between marker comments", async () => {
    seedFeature("p1", "001-build");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-merge-"));
    try {
      const original = "# AGENTS\n\nWelcome to the project.\n";
      await fs.writeFile(path.join(tmp, "AGENTS.md"), original, "utf8");
      const result = await runInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["codex"],
        apiBaseUrl: "https://metis.local",
        consent: true,
      });
      expect(result.written).toBeGreaterThan(0);
      const merged = await fs.readFile(path.join(tmp, "AGENTS.md"), "utf8");
      expect(merged).toContain("# AGENTS");
      expect(merged).toContain("Welcome to the project.");
      expect(merged).toContain("$speckit-specify");
      expect(merged).toContain("<!-- speckit:start -->");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("planInstall returns a non-empty list", async () => {
    seedFeature("p1", "001-build");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-plan-"));
    try {
      const files = await planInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["copilot"],
        apiBaseUrl: "https://metis.local",
        consent: true,
      });
      expect(files.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("runInstall (real fs)", () => {
  it("writes new files and skips on the second pass (skip mode)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-install-"));
    try {
      const fid = seedFeature("p1", "001-build");
      seedArtifact(fid, "spec.md", "Spec");
      const r1 = await runInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["copilot"],
        apiBaseUrl: "https://metis.local",
        consent: true,
      });
      expect(r1.written).toBeGreaterThan(0);
      expect(r1.skipped).toBe(0);

      const r2 = await runInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["copilot"],
        apiBaseUrl: "https://metis.local",
        consent: true,
      });
      expect(r2.skipped).toBeGreaterThan(0);
      expect(r2.written).toBe(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("overwrite mode replaces existing content", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-install-"));
    try {
      const fid = seedFeature("p1", "001-build");
      seedArtifact(fid, "spec.md", "v1");
      await runInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["copilot"],
        apiBaseUrl: "https://metis.local",
        consent: true,
      });
      featureArtifactRows.get("fa_f_001-build_spec.md")!.content = "v2";
      const r2 = await runInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["copilot"],
        apiBaseUrl: "https://metis.local",
        consent: true,
        mode: "overwrite",
      });
      expect(r2.written).toBeGreaterThan(0);
      const body = await fs.readFile(path.join(tmp, "specs/001-build/spec.md"), "utf8");
      expect(body).toBe("v2");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("apiBaseUrl allowlist (S-4)", () => {
  it("rejects an apiBaseUrl that is not on the allowlist", async () => {
    seedFeature("p1", "001-build");
    await expect(
      runInstall({
        projectId: "p1",
        workspaceRoot: "/tmp/ws",
        hosts: ["copilot"],
        apiBaseUrl: "https://attacker.example.com",
        consent: true,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ status: 422, code: "apiBaseUrl_not_allowed" });
  });

  it("accepts an apiBaseUrl that matches METIS_PUBLIC_URL exactly", async () => {
    seedFeature("p1", "001-build");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-allow-"));
    try {
      const result = await runInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["copilot"],
        apiBaseUrl: "https://metis.local",
        consent: true,
        dryRun: true,
      });
      expect(result.files.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("accepts an apiBaseUrl on the SPECKIT_INSTALL_ALLOWED_API_HOSTS CSV", async () => {
    process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS =
      "https://metis.local,https://metis-staging.example.com";
    seedFeature("p1", "001-build");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speckit-allow-"));
    try {
      const result = await runInstall({
        projectId: "p1",
        workspaceRoot: tmp,
        hosts: ["copilot"],
        apiBaseUrl: "https://metis-staging.example.com/some/path",
        consent: true,
        dryRun: true,
      });
      expect(result.files.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a malformed apiBaseUrl", async () => {
    await expect(
      runInstall({
        projectId: "p1",
        workspaceRoot: "/tmp/ws",
        hosts: ["copilot"],
        apiBaseUrl: "not-a-url",
        consent: true,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ status: 422, code: "apiBaseUrl_not_allowed" });
  });
});
