/**
 * #2594 — "Publish to Jira" on an impact analysis previews before it sends.
 *
 * `GET /api/impact-analyses/:id/publish/jira/preview` names the Jira project
 * (key and site) and METIS project the issue goes to, how many issues would be
 * created and the issue title, and sends nothing to Jira. After a publish, the
 * same preview says the run was published before, names that issue, and says
 * no new one would be created; publishing again then creates none.
 *
 * Real SQLite built by the migration chain, the real router, the real
 * finding-publisher and its Prisma ports, real JWTs. Only the Jira HTTP client,
 * the vault read and the host allowlist are faked.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload } from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: vi.fn(() => ({
    read: vi.fn().mockResolvedValue({ plaintext: "jira-token" }),
  })),
}));
vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn().mockResolvedValue(undefined),
}));
const jiraCreateIssue = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/connectors/jira/jira-client.js", () => ({
  createJiraClient: vi.fn(() => ({ createIssue: jiraCreateIssue })),
}));

const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-2594";
/** Two run projects: A has no Jira configured, B publishes to Jira key `MFX`. */
const PA = "proj-a-2594";
const PB = "proj-b-2594";
const RUN = "ia-run-2594";
const RUN_UNCONFIGURED = "ia-unconf-2594";
const JIRA_SITE = "https://jira.example.test";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2594 — Jira publish from an impact analysis previews before it sends",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const payload: AuthPayload = {
      userId: "alice",
      username: "alice",
      role: "coordinator",
      permissions: getPermissionsForRole("coordinator"),
      workspaces: [WS],
    };
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const bearer = () => `Bearer ${issueTokens(payload).accessToken}`;
    const preview = (id: string) =>
      request(app())
        .get(`/api/impact-analyses/${id}/publish/jira/preview`)
        .set("Authorization", bearer());
    const publish = (id: string, body: object) =>
      request(app())
        .post(`/api/impact-analyses/${id}/publish/jira`)
        .set("Authorization", bearer())
        .send(body);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2594-impact-jira-preview");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.role.create({ data: { id: "role-coordinator", key: "coordinator", name: "c" } });
      await db.user.create({
        data: { id: "alice", username: "alice", displayName: "Alice", email: "a@example.test" },
      });
      await db.userRole.create({ data: { userId: "alice", roleId: "role-coordinator" } });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.workspaceMember.create({
        data: { workspaceId: WS, userId: "alice", role: "member" },
      });
      for (const [id, name] of [
        [PA, "Miniflux Docs"],
        [PB, "Miniflux Server"],
      ] as const) {
        await db.project.create({
          data: { id, name, slug: id, createdById: "alice", workspaceId: WS, status: "active" },
        });
      }
      await db.secret.create({
        data: { id: "sec-2594", name: "jira-2594", ciphertext: "c", iv: "i", tag: "t", salt: "s" },
      });
      await db.jiraConnection.create({
        data: {
          id: "jc-2594",
          projectId: PB,
          label: "Jira",
          edition: "cloud",
          baseUrl: JIRA_SITE,
          username: "svc",
          secretId: "sec-2594",
          status: "ok",
          createdById: "alice",
        },
      });
      await db.project.update({
        where: { id: PB },
        data: { jiraConnectionId: "jc-2594", jiraProjectKey: "MFX" },
      });
      for (const [id, projectIds] of [
        [RUN, [PA, PB]],
        [RUN_UNCONFIGURED, [PA]],
      ] as const) {
        await db.impactAnalysis.create({
          data: {
            id,
            status: "completed",
            summary: "Add a reading-time estimate to each entry",
            startedById: "alice",
            completedAt: new Date(),
            projects: { create: projectIds.map((projectId) => ({ projectId })) },
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      jiraCreateIssue.mockReset();
      jiraCreateIssue.mockResolvedValue({ key: "MFX-12" });
    });

    it("names the Jira project, site, METIS project, count and title, and sends nothing", async () => {
      const res = await preview(RUN);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        provider: "jira",
        project: { id: PB, name: "Miniflux Server" },
        jiraProjectKey: "MFX",
        jiraSite: JIRA_SITE,
        title: "Impact analysis: Add a reading-time estimate to each entry",
        issuesToCreate: 1,
        alreadyPublished: null,
      });
      expect(jiraCreateIssue).not.toHaveBeenCalled();
      expect(await db.issueLink.count({ where: { impactAnalysisId: RUN } })).toBe(0);
    });

    it("refuses with JIRA_NOT_CONFIGURED when no run project publishes to Jira", async () => {
      const res = await preview(RUN_UNCONFIGURED);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("JIRA_NOT_CONFIGURED");
    });

    it("after a publish, says the run was published before and that nothing new would be created", async () => {
      const first = await publish(RUN, { projectId: PB });
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual({
        provider: "jira",
        issueKey: "MFX-12",
        url: `${JIRA_SITE}/browse/MFX-12`,
      });
      expect(jiraCreateIssue).toHaveBeenCalledTimes(1);

      const again = await preview(RUN);
      expect(again.status).toBe(200);
      expect(again.body.data.issuesToCreate).toBe(0);
      expect(again.body.data.alreadyPublished).toEqual({
        issueKey: "MFX-12",
        url: `${JIRA_SITE}/browse/MFX-12`,
        publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });

      // What the preview promised: publishing again creates no second issue.
      const second = await publish(RUN, { projectId: PB });
      expect(second.status).toBe(200);
      expect(second.body.data.issueKey).toBe("MFX-12");
      expect(jiraCreateIssue).toHaveBeenCalledTimes(1);
    });
  },
);
