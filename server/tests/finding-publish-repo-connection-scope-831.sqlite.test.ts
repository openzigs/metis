/**
 * #831 — `createGitHubIssue` loads the repo connection, which supplies the
 * GitHub credential, scoped by `projectId`. Nothing pinned that scope: removing
 * `projectId` from the lookup left every publishing, analysis and scan test
 * green, and a publish for project A could then go out with project B's
 * connector token.
 *
 * Two projects, each with its own repo connection and token, in a real SQLite
 * database from the migration chain. Only the vault read (secret id → token)
 * and the Octokit client are faked, so the token handed to
 * `acquirePublishOctokit` is the one the real lookup selected.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../src/lib/vault/vault-service.js", () => ({ getVaultService: vi.fn(() => ({})) }));
vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  readBoundSecret: vi.fn(async (secretId: string) => `token-of-${secretId}`),
}));
const acquire = vi.fn(async (_opts: { owner: string; baseUrl: string; token: string }) => ({
  request: vi.fn(async () => ({
    status: 201,
    headers: {},
    data: { number: 7, html_url: "https://github.com/openzigs/sandbox/issues/7" },
  })),
}));
vi.mock("../src/lib/publishing/octokit-factory.js", () => ({
  acquirePublishOctokit: (opts: { owner: string; baseUrl: string; token: string }) => acquire(opts),
}));

const { buildSharedFindingPublisherPorts, PUBLISH_AUDIT_SUBJECTS } =
  await import("../src/lib/publishing/finding-publish-ports.js");

const PROJECT_A = "proj-831-a";
const PROJECT_B = "proj-831-b";
const CONN_A = "conn-831-a";
const CONN_B = "conn-831-b";
const SECRET_A = "secret-831-a";
const SECRET_B = "secret-831-b";
const TARGET = { owner: "openzigs", repo: "sandbox" };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#831 — createGitHubIssue only ever uses the publishing project's repo connection",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const publish = (projectId: string, repoConnectionId: string) =>
      buildSharedFindingPublisherPorts(PUBLISH_AUDIT_SUBJECTS.analysis).createGitHubIssue({
        projectId,
        repoConnectionId,
        title: "Finding",
        body: "body",
        labels: [],
        target: TARGET,
      });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("831-repo-connection-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-831", username: "u-831", displayName: "U", email: "u-831@example.test" },
      });
      for (const [projectId, connId, secretId] of [
        [PROJECT_A, CONN_A, SECRET_A],
        [PROJECT_B, CONN_B, SECRET_B],
      ] as const) {
        await db.project.create({
          data: { id: projectId, name: projectId, slug: projectId, createdById: "u-831" },
        });
        await db.secret.create({
          data: { id: secretId, name: secretId, ciphertext: "x", iv: "x", tag: "x", salt: "x" },
        });
        await db.repoConnection.create({
          data: {
            id: connId,
            projectId,
            label: connId,
            ownerOrOrg: "openzigs",
            repoName: connId,
            secretId,
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      acquire.mockClear();
    });

    it("publishes project A's finding with project A's connector token", async () => {
      await expect(publish(PROJECT_A, CONN_A)).resolves.toMatchObject({ externalId: "7" });

      expect(acquire).toHaveBeenCalledOnce();
      expect(acquire.mock.calls[0]![0].token).toBe(`token-of-${SECRET_A}`);
    });

    it("refuses project B's connection for project A, never touching B's token", async () => {
      await expect(publish(PROJECT_A, CONN_B)).rejects.toThrow(
        `repo connection ${CONN_B} not found`,
      );

      expect(acquire).not.toHaveBeenCalled();
    });

    it("refuses project A's connection for project B", async () => {
      await expect(publish(PROJECT_B, CONN_A)).rejects.toThrow(
        `repo connection ${CONN_A} not found`,
      );

      expect(acquire).not.toHaveBeenCalled();
    });
  },
);
