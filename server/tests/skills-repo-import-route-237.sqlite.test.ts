/**
 * #237 — `POST /api/skills/import/repository`: a skills import from a
 * project's git repository connector, through the real route, the real
 * `openRepoContentFetcher` (connector lookup, git-provider check, host
 * allowlist + DNS pin, vault-resolved credential) and `RepoLoader`, into a real
 * SQLite database. Only the GitHub API (a fake Octokit) and DNS are stubbed.
 *
 * The route carries the SAME permission as the inline import (`skill.manage`);
 * the caller must reach the project and the connector must be that project's.
 * Every refusal is checked to fetch nothing and create nothing.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// No DNS: the allowlist is exercised elsewhere; here it admits the API host.
vi.mock("../src/lib/connectors/network-allowlist.js", async (original) => ({
  ...(await original<typeof import("../src/lib/connectors/network-allowlist.js")>()),
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async (hostname: string) => ({
    address: "192.0.2.1",
    family: 4,
    hostname,
  })),
}));

const { skillsRouter } = await import("../src/routes/skills.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { __setOctokitFactory } = await import("../src/lib/connectors/repo/repo-service.js");

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill.\nversion: 1.0.0\n---\n\nRead references/guide.md first.\n`;

/** The repository the fake GitHub API serves. */
const TREE: Record<string, string> = {
  "skills/pdf/SKILL.md": skillMd("repo-pdf"),
  "skills/pdf/references/guide.md": "GUIDE-MARKER",
  "README.md": "outside the import root",
};

function contentOf(path: string) {
  if (path in TREE) {
    const content = Buffer.from(TREE[path]!, "utf8").toString("base64");
    return { type: "file" as const, encoding: "base64", content, path, size: TREE[path]!.length };
  }
  const prefix = path === "" ? "" : `${path}/`;
  const children = new Map<
    string,
    { type: "dir" | "file"; name: string; path: string; size: number }
  >();
  for (const p of Object.keys(TREE)) {
    if (!p.startsWith(prefix)) continue;
    const [head, ...tail] = p.slice(prefix.length).split("/");
    const child = `${prefix}${head}`;
    children.set(child, {
      type: tail.length > 0 ? "dir" : "file",
      name: head!,
      path: child,
      size: tail.length > 0 ? 0 : TREE[child]!.length,
    });
  }
  if (children.size === 0) throw Object.assign(new Error("Not Found"), { status: 404 });
  return [...children.values()];
}

const getContent = vi.fn(async (p: { owner: string; repo: string; path: string }) => ({
  data: contentOf(p.path),
}));

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#237 POST /api/skills/import/repository — a repository connector's skills, with their files",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const token = (userId: string, role: "admin" | "developer" | "coordinator") =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces: [] }).accessToken;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/skills", skillsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const importRepo = (body: Record<string, unknown>, bearer?: string) => {
      const req = request(app()).post("/api/skills/import/repository");
      if (bearer) req.set("Authorization", `Bearer ${bearer}`);
      return req.send(body);
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("237-repo-import-route");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-admin", username: "u-admin", displayName: "a", email: "a@example.test" },
      });
      await db.user.create({
        data: { id: "u-dev", username: "u-dev", displayName: "d", email: "d@example.test" },
      });
      for (const id of ["p-1", "p-2"]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: "u-admin" } });
      }
      await db.repoConnection.create({
        data: {
          id: "rc-1",
          projectId: "p-1",
          label: "one",
          provider: "github",
          ownerOrOrg: "acme-test",
          repoName: "skills-repo",
        },
      });
      await db.repoConnection.create({
        data: {
          id: "rc-2",
          projectId: "p-2",
          label: "two",
          provider: "github",
          ownerOrOrg: "acme-test",
          repoName: "other-repo",
        },
      });
      await db.repoConnection.create({
        data: { id: "rc-local", projectId: "p-1", label: "local", provider: "local" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      __setOctokitFactory(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      getContent.mockClear();
      __setOctokitFactory(
        () =>
          ({
            rest: { repos: { getContent } },
          }) as never,
      );
    });
    afterEach(() => {
      delete process.env.SKILL_REPO_IMPORT_RATE_LIMIT_MAX;
    });

    it("imports each SKILL.md with its supporting files from the project's connector", async () => {
      const res = await importRepo(
        { projectId: "p-1", connectorId: "rc-1", path: "skills" },
        token("u-admin", "admin"),
      );
      expect(res.status, res.text).toBe(201);
      expect(res.body.data.failed).toEqual([]);
      expect(res.body.data.imported.map((s: { key: string }) => s.key)).toEqual(["repo-pdf"]);
      // Only the import root was walked; README.md at the repo root was never read.
      const paths = getContent.mock.calls.map((c) => c[0].path);
      expect(paths).not.toContain("README.md");
      expect(getContent.mock.calls.every((c) => c[0].repo === "skills-repo")).toBe(true);
      const skill = await db.skill.findFirst({ where: { key: "repo-pdf" } });
      expect(skill?.source).toBe("repo:acme-test/skills-repo");
      const files = await db.skillFile.findMany({ where: { skillId: skill!.id } });
      expect(files.map((f) => f.path)).toEqual(["references/guide.md"]);
    });

    const refusals: Array<{
      name: string;
      bearer: () => string | undefined;
      body: Record<string, unknown>;
      status: number;
      code: string;
    }> = [
      {
        name: "unauthenticated",
        bearer: () => undefined,
        body: { projectId: "p-1", connectorId: "rc-1" },
        status: 401,
        code: "AUTH_REQUIRED",
      },
      {
        name: "a role without skill.manage (coordinator)",
        bearer: () => token("u-dev", "coordinator"),
        body: { projectId: "p-1", connectorId: "rc-1" },
        status: 403,
        code: "FORBIDDEN",
      },
      {
        name: "a role without skill.manage (developer)",
        bearer: () => token("u-dev", "developer"),
        body: { projectId: "p-1", connectorId: "rc-1" },
        status: 403,
        code: "FORBIDDEN",
      },
      {
        name: "another project's connector",
        bearer: () => token("u-admin", "admin"),
        body: { projectId: "p-1", connectorId: "rc-2" },
        status: 404,
        code: "REPO_CONNECTOR_NOT_FOUND",
      },
      {
        name: "a project that does not exist",
        bearer: () => token("u-admin", "admin"),
        body: { projectId: "p-none", connectorId: "rc-1" },
        status: 404,
        code: "REPO_CONNECTOR_NOT_FOUND",
      },
      {
        name: "a connector that is not a git provider",
        bearer: () => token("u-admin", "admin"),
        body: { projectId: "p-1", connectorId: "rc-local" },
        status: 400,
        code: "NOT_GIT_PROVIDER",
      },
      {
        name: "an import path that leaves the repository",
        bearer: () => token("u-admin", "admin"),
        body: { projectId: "p-1", connectorId: "rc-1", path: "../etc" },
        status: 400,
        code: "INVALID_ROOT",
      },
      {
        name: "no connector named",
        bearer: () => token("u-admin", "admin"),
        body: { projectId: "p-1" },
        status: 400,
        code: "VALIDATION_ERROR",
      },
    ];
    for (const c of refusals) {
      it(`refuses ${c.name} — fetches nothing, creates nothing`, async () => {
        const before = await db.skill.count();
        const res = await importRepo(c.body, c.bearer());
        expect(res.status, res.text).toBe(c.status);
        expect(res.body.error?.code).toBe(c.code);
        if (c.code !== "INVALID_ROOT") expect(getContent).not.toHaveBeenCalled();
        expect(await db.skill.count()).toBe(before);
      });
    }

    it("is rate-limited per IP BEFORE authentication (an anonymous flood gets 429, not 401)", async () => {
      process.env.SKILL_REPO_IMPORT_RATE_LIMIT_MAX = "1";
      const res = await importRepo({ projectId: "p-1", connectorId: "rc-1" });
      expect(res.status).toBe(429);
      expect(res.body.error?.code).toBe("SKILL_IMPORT_RATE_LIMITED");
      expect(getContent).not.toHaveBeenCalled();
    });
  },
);
