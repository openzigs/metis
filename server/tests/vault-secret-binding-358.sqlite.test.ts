/**
 * #358 — the #344 binding rule on the remaining caller-chosen destinations.
 *
 * #344 bound a vault secret used by reference to its destination on DB / repo
 * connectors, a project's primary repo and MCP servers. The same shape — a
 * caller without `vault.reveal` choosing both the secret and where it is sent —
 * also existed on:
 *
 *   - `POST /api/projects/:id/github/projects-v2-boards` (`secretRef` + `targetBaseUrl`)
 *   - `POST /api/projects/:projectId/publishing/batches` (live: `secretRef` + `targetBaseUrl`)
 *   - `PATCH /api/jira/connections/:id` and `PATCH /api/test-management/connections/:id`,
 *     which move a connection holding a credential someone else supplied to a new
 *     base URL / proxy / TLS setting without re-supplying it.
 *
 * Every path runs through its REAL router, REAL auth, REAL vault and REAL audit
 * service against a REAL SQLite database built from the migration chain. Only
 * the network edge is stubbed: DNS pinning (no real lookups) and the Octokit
 * factory, which records the token it was handed — the proof that a refused
 * secret never left the process is that the factory never saw it.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
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
  return { db: null as unknown, tokensSent: [] as Array<{ baseUrl: string; token: string }> };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
// Network edge only: no DNS, and every host is "allowed" so the binding rule —
// not the SSRF allow-list — is what these tests observe.
vi.mock("../src/lib/connectors/network-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertConnectorHostAllowed: async () => undefined,
    resolveAndAssertConnectorHost: async (hostname: string) => ({
      hostname,
      address: "203.0.113.7",
      family: 4,
    }),
  };
});
vi.mock("../src/lib/publishing/octokit-factory.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    acquirePublishOctokit: async (opts: { baseUrl: string; token: string }) => {
      state.tokensSent.push({ baseUrl: opts.baseUrl, token: opts.token });
      throw new Error("network stubbed in #358 test");
    },
  };
});

const { projectsRouter } = await import("../src/routes/projects.js");
const { publishingRouter } = await import("../src/routes/publishing.js");
const { jiraRouter } = await import("../src/routes/jira.js");
const { testManagementRouter } = await import("../src/routes/test-management.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { resolveVaultRef } = await import("../src/lib/connectors/vault-resolver.js");
const { expandVaultRefs } = await import("../src/lib/vault/env-manager.js");

type Method = "get" | "post" | "patch";

const PROJ = "proj-358-binding-01";
const FORBIDDEN = "SECRET_BINDING_FORBIDDEN";
const EVIL = "https://attacker.example.test/api/v3";
const ref = (body: string) => `\${vault:${body}}`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#358 — vault secrets are bound on the remaining caller-chosen destinations",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ADMIN = "";
    let COORD = "";
    /** Created by the admin: the coordinator may list it but never saw its value. */
    let FOREIGN = "";
    const FOREIGN_VALUE = "admin-pat-value-358";
    /** Created by the coordinator: they supplied the value. */
    let OWN = "";
    const OWN_VALUE = "coord-pat-value-358";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/publishing", publishingRouter());
      a.use("/api/projects", projectsRouter());
      a.use("/api/jira", jiraRouter());
      a.use("/api/test-management", testManagementRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (method: Method, url: string, bearer: string, body?: unknown) => {
      const r = request(app())[method](url).set("Authorization", `Bearer ${bearer}`);
      return body === undefined ? r : r.send(body as object);
    };
    const refusals = async (targetType: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({
        where: { action: "vault.binding_refused", targetType, actorId: "u-coord" },
      });
    };
    const sent = () => state.tokensSent.map((t) => t.token);

    let seq = 0;
    const next = () => (seq += 1);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("358-secret-binding");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();

      for (const id of ["u-admin", "u-coord"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-1", name: "ws-1", slug: "ws-1" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1", userId: "u-coord", role: "member" },
      });
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, createdById: "u-admin", workspaceId: "ws-1" },
      });

      const vault = getVaultService();
      FOREIGN = (
        await vault.create("admin-gh-pat-358", FOREIGN_VALUE, "global", { createdById: "u-admin" })
      ).id;
      OWN = (
        await vault.create("coord-gh-pat-358", OWN_VALUE, "global", { createdById: "u-coord" })
      ).id;

      const token = (userId: string, role: "admin" | "coordinator", workspaces: string[]) =>
        issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
      ADMIN = token("u-admin", "admin", []);
      COORD = token("u-coord", "coordinator", ["ws-1"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      state.tokensSent.length = 0;
    });

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── Projects v2 boards ───────────────────────────────────────────────────
    describe("POST /api/projects/:id/github/projects-v2-boards", () => {
      const boards = `/api/projects/${PROJ}/github/projects-v2-boards`;
      const body = (secretRef: string, targetBaseUrl?: string) => ({
        secretRef,
        targetOwner: "octo",
        ...(targetBaseUrl ? { targetBaseUrl } : {}),
      });

      it("a coordinator cannot send a secret they did not create to a host they chose", async () => {
        const before = await refusals("github_projects_v2");
        for (const secretRef of [ref(FOREIGN), ref("admin-gh-pat-358"), ref("no-such-358")]) {
          const res = await call("post", boards, COORD, body(secretRef, EVIL));
          expect(res.status, JSON.stringify(res.body)).toBe(403);
          expect(res.body.error.code).toBe(FORBIDDEN);
        }
        expect(sent()).toEqual([]);
        expect((await refusals("github_projects_v2")).length).toBe(before.length + 3);
      });

      it("a coordinator may send a secret they created to a host they chose", async () => {
        await call("post", boards, COORD, body(ref(OWN), EVIL));
        expect(state.tokensSent).toEqual([{ baseUrl: EVIL, token: OWN_VALUE }]);
      });

      it("public api.github.com is not a caller-chosen destination", async () => {
        await call("post", boards, COORD, body(ref(FOREIGN)));
        await call("post", boards, COORD, body(ref(FOREIGN), "https://api.github.com"));
        expect(sent()).toEqual([FOREIGN_VALUE, FOREIGN_VALUE]);
      });

      it("an admin may send any secret anywhere", async () => {
        await call("post", boards, ADMIN, body(ref(FOREIGN), EVIL));
        expect(sent()).toEqual([FOREIGN_VALUE]);
      });

      /** A secret row under an exact stored name (legacy names, bare names). */
      const rawSecret = (name: string, createdById: string) =>
        db.secret.create({
          data: {
            name,
            ciphertext: "x",
            iv: "",
            tag: "",
            salt: "",
            keyVersion: 1,
            algorithm: "aes-256-gcm",
            createdById,
          },
        });

      it("a reference to the caller's own row that also reaches someone else's is refused", async () => {
        // Each reference below names a row the coordinator owns AND, by label,
        // an admin row; the #358 secretsReachableBy filter must fetch both or
        // the check would approve a reference the resolver could send elsewhere.
        // Scoped ref: own `global:x`, admin legacy-named `legacy:x` (scope global, label x).
        await getVaultService().create("scoped-358", "coord-shared", "global", {
          createdById: "u-coord",
        });
        await rawSecret("legacy:scoped-358", "u-admin");
        // Bare ref: own bare-named row `y`, admin `global:y`.
        await rawSecret("bare-358", "u-coord");
        await getVaultService().create("bare-358", "admin-shared", "global", {
          createdById: "u-admin",
        });
        // Scoped ref reaching a bare-named row (PR #392 panel): own `global:z`,
        // admin bare-named `z`. Only the `{ name: label }` candidate fetches it.
        await getVaultService().create("bare-scoped-358", "coord-own", "global", {
          createdById: "u-coord",
        });
        await rawSecret("bare-scoped-358", "u-admin");
        for (const secretRef of [
          ref("global:scoped-358"),
          ref("bare-358"),
          ref("global:bare-scoped-358"),
        ]) {
          const res = await call("post", boards, COORD, body(secretRef, EVIL));
          expect(res.status, `${secretRef} ${JSON.stringify(res.body)}`).toBe(403);
        }
        expect(sent()).toEqual([]);
      });
    });

    // ── Publishing batches ───────────────────────────────────────────────────
    describe("POST /api/projects/:projectId/publishing/batches", () => {
      const batches = `/api/projects/${PROJ}/publishing/batches`;
      const draft = async () =>
        (
          await db.issueDraft.create({
            data: { projectId: PROJ, title: `Draft ${next()}`, body: "b", status: "approved" },
          })
        ).id;
      const batchBody = async (secretRef: string, targetBaseUrl?: string, dryRun = false) => ({
        targetOwner: "octo",
        targetRepo: `repo-${next()}`,
        provider: targetBaseUrl ? "github_enterprise" : "github",
        draftIds: [await draft()],
        dryRun,
        secretRef,
        ...(targetBaseUrl ? { targetBaseUrl } : {}),
      });

      it("a live batch to a caller-chosen host refuses a secret the caller did not create", async () => {
        const res = await call("post", batches, COORD, await batchBody(ref(FOREIGN), EVIL));
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error.code).toBe(FORBIDDEN);
        expect(sent()).toEqual([]);
        expect(await db.publishBatch.count({ where: { projectId: PROJ } })).toBe(0);
        expect((await refusals("publish_batch")).length).toBeGreaterThan(0);
      });

      it("a live batch to a caller-chosen host may use the caller's own secret", async () => {
        await call("post", batches, COORD, await batchBody(ref(OWN), EVIL));
        expect(state.tokensSent).toEqual([{ baseUrl: EVIL, token: OWN_VALUE }]);
      });

      it("caller metadata cannot override the checked secretRef or the other reserved keys", async () => {
        // PR #392 review: `metadata.secretRef` used to win over the top-level
        // ref the route checked, so the admin's token reached the caller's host.
        const body = await batchBody(ref(OWN), EVIL);
        const smuggledDraft = await draft();
        const res = await call("post", batches, COORD, {
          ...body,
          metadata: {
            secretRef: ref(FOREIGN),
            draftIds: [smuggledDraft],
            additionalLabels: ["smuggled"],
            milestone: 99,
            note: "kept",
          },
        });
        // The stubbed network makes the run itself fail; what matters is the token sent.
        expect(res.status, JSON.stringify(res.body)).not.toBe(403);
        expect(sent()).not.toContain(FOREIGN_VALUE);
        expect(state.tokensSent).toEqual([{ baseUrl: EVIL, token: OWN_VALUE }]);
        const batch = await db.publishBatch.findFirstOrThrow({
          where: { projectId: PROJ, targetRepo: body.targetRepo },
        });
        const meta = JSON.parse(batch.metadata ?? "{}") as Record<string, unknown>;
        expect(meta.secretRef).toBe(ref(OWN));
        expect(meta.draftIds).toEqual(body.draftIds);
        expect(meta.additionalLabels).not.toEqual(["smuggled"]);
        expect(meta.milestone).not.toBe(99);
        expect(meta.note).toBe("kept");
      });

      it("public GitHub and dry runs send nothing anywhere new, so they are not refused", async () => {
        const pub = await call("post", batches, COORD, await batchBody(ref(FOREIGN)));
        expect(pub.status, JSON.stringify(pub.body)).not.toBe(403);
        expect(sent()).toEqual([FOREIGN_VALUE]);
        const dry = await call("post", batches, COORD, await batchBody(ref(FOREIGN), EVIL, true));
        expect(dry.status, JSON.stringify(dry.body)).toBe(201);
        expect(sent()).toEqual([FOREIGN_VALUE]);
      });

      it("an admin may publish with any secret to any host", async () => {
        await call("post", batches, ADMIN, await batchBody(ref(FOREIGN), EVIL));
        expect(sent()).toEqual([FOREIGN_VALUE]);
      });
    });

    // ── Jira connections ─────────────────────────────────────────────────────
    describe("PATCH /api/jira/connections/:id", () => {
      const conns = `/api/jira/connections?projectId=${PROJ}`;
      const create = async (bearer: string) => {
        const res = await call("post", conns, bearer, {
          label: `jira-${next()}`,
          edition: "datacenter",
          baseUrl: "https://jira.internal.example.test",
          username: "svc",
          apiToken: "jira-token-358",
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.jiraConnection.findUnique({ where: { id } });

      it("the API token is owned by whoever supplied it", async () => {
        const id = await create(COORD);
        const secret = await db.secret.findUnique({ where: { id: (await row(id))!.secretId } });
        expect(secret?.createdById).toBe("u-coord");
      });

      it("a coordinator cannot move a connection holding a token they did not supply", async () => {
        for (const patch of [
          { baseUrl: "https://attacker.example.test" },
          { proxyUrl: "https://attacker.example.test" },
          { tlsRejectUnauthorized: false },
          { tlsCaCert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" },
        ]) {
          const id = await create(ADMIN);
          const before = await row(id);
          const res = await call("patch", `/api/jira/connections/${id}`, COORD, patch);
          expect(res.status, JSON.stringify(patch)).toBe(403);
          expect(res.body.error.code).toBe(FORBIDDEN);
          expect(await row(id)).toEqual(before);
        }
        expect((await refusals("jira_connection")).length).toBeGreaterThanOrEqual(4);
      });

      it("a legacy connection whose token has no owner is refused too", async () => {
        const id = await create(ADMIN);
        await db.secret.update({
          where: { id: (await row(id))!.secretId },
          data: { createdById: null },
        });
        const res = await call("patch", `/api/jira/connections/${id}`, COORD, {
          baseUrl: "https://attacker.example.test",
        });
        expect(res.status).toBe(403);
      });

      it("a coordinator may edit what does not move the token, or move it with their own token", async () => {
        const id = await create(ADMIN);
        const adminSecret = (await row(id))!.secretId;
        const adminCiphertext = (await db.secret.findUniqueOrThrow({ where: { id: adminSecret } }))
          .ciphertext;
        const renamed = await call("patch", `/api/jira/connections/${id}`, COORD, {
          label: `renamed-${next()}`,
          baseUrl: "https://jira.internal.example.test",
          username: "other",
        });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        const moved = await call("patch", `/api/jira/connections/${id}`, COORD, {
          baseUrl: "https://mine.example.test",
          apiToken: "coord-jira-token",
        });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        const after = await row(id);
        expect(after?.baseUrl).toBe("https://mine.example.test");
        // The admin's secret is not rewritten with the coordinator's value: the
        // connection now points at a fresh secret the coordinator owns.
        expect(after?.secretId).not.toBe(adminSecret);
        // #481 — and the admin's secret, now unreferenced, is retired untouched.
        const old = await db.secret.findUniqueOrThrow({ where: { id: adminSecret } });
        expect(old.ciphertext).toBe(adminCiphertext);
        expect(old.deletedAt).not.toBeNull();
        expect((await getVaultService().read(after!.secretId)).plaintext).toBe("coord-jira-token");
        expect((await db.secret.findUnique({ where: { id: after!.secretId } }))?.createdById).toBe(
          "u-coord",
        );
      });

      it("a coordinator may move their own connection; an admin may move any", async () => {
        const own = await create(COORD);
        const a = await call("patch", `/api/jira/connections/${own}`, COORD, {
          baseUrl: "https://mine.example.test",
        });
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        const theirs = await create(COORD);
        const b = await call("patch", `/api/jira/connections/${theirs}`, ADMIN, {
          baseUrl: "https://elsewhere.example.test",
        });
        expect(b.status, JSON.stringify(b.body)).toBe(200);
      });
    });

    // ── Test-management connections ──────────────────────────────────────────
    describe("PATCH /api/test-management/connections/:id", () => {
      const conns = `/api/test-management/connections?projectId=${PROJ}`;
      const create = async (bearer: string) => {
        const res = await call("post", conns, bearer, {
          label: `tm-${next()}`,
          kind: "zephyr",
          baseUrl: "https://zephyr.internal.example.test",
          auth: { kind: "zephyr", bearerToken: "zephyr-token-358" },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.testManagementConnection.findUnique({ where: { id } });
      const tokenId = async (id: string) =>
        /\$\{vault:([^}]+)\}/.exec(
          (JSON.parse((await row(id))!.authConfigJson) as { bearerTokenRef: string })
            .bearerTokenRef,
        )![1];

      it("the credentials are owned by whoever supplied them", async () => {
        const id = await create(COORD);
        expect(
          (await db.secret.findUnique({ where: { id: await tokenId(id) } }))?.createdById,
        ).toBe("u-coord");
      });

      it("a coordinator cannot move a connection holding credentials they did not supply", async () => {
        for (const patch of [
          { baseUrl: "https://attacker.example.test" },
          { proxyConfig: { url: "https://attacker.example.test" } },
          { tlsConfig: { rejectUnauthorized: false } },
          { tlsConfig: { caCert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" } },
        ]) {
          const id = await create(ADMIN);
          const before = await row(id);
          const res = await call("patch", `/api/test-management/connections/${id}`, COORD, patch);
          expect(res.status, JSON.stringify(patch)).toBe(403);
          expect(res.body.error.code).toBe(FORBIDDEN);
          expect(await row(id)).toEqual(before);
        }
        expect((await refusals("test_management_connection")).length).toBeGreaterThanOrEqual(4);
      });

      it("a coordinator may edit what does not move the credentials, or move them with their own", async () => {
        const id = await create(ADMIN);
        const adminSecret = await tokenId(id);
        const adminCiphertext = (await db.secret.findUniqueOrThrow({ where: { id: adminSecret } }))
          .ciphertext;
        const renamed = await call("patch", `/api/test-management/connections/${id}`, COORD, {
          label: `renamed-${next()}`,
          baseUrl: "https://zephyr.internal.example.test",
          tlsConfig: { rejectUnauthorized: true },
        });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        const moved = await call("patch", `/api/test-management/connections/${id}`, COORD, {
          baseUrl: "https://mine.example.test",
          auth: { kind: "zephyr", bearerToken: "coord-zephyr-token" },
        });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        expect((await row(id))?.baseUrl).toBe("https://mine.example.test");
        expect(await tokenId(id)).not.toBe(adminSecret);
        // #481 — the admin's secret is not overwritten, and is retired once unreferenced.
        const old = await db.secret.findUniqueOrThrow({ where: { id: adminSecret } });
        expect(old.ciphertext).toBe(adminCiphertext);
        expect(old.deletedAt).not.toBeNull();
        expect((await getVaultService().read(await tokenId(id))).plaintext).toBe(
          "coord-zephyr-token",
        );
      });

      it("a coordinator may move their own connection; an admin may move any", async () => {
        const own = await create(COORD);
        const a = await call("patch", `/api/test-management/connections/${own}`, COORD, {
          baseUrl: "https://mine.example.test",
        });
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        const b = await call("patch", `/api/test-management/connections/${own}`, ADMIN, {
          baseUrl: "https://elsewhere.example.test",
        });
        expect(b.status, JSON.stringify(b.body)).toBe(200);
      });
    });

    // ── Label time-of-check / time-of-use ────────────────────────────────────
    describe("a label reference that later reaches a second secret", () => {
      it("fails closed in both resolvers instead of picking the newest row", async () => {
        const vault = getVaultService();
        await vault.create("toctou-label-358", "coord-value", "global", {
          createdById: "u-coord",
        });
        const label = ref("toctou-label-358");
        expect(await resolveVaultRef(label, vault)).toBe("coord-value");
        expect(await expandVaultRefs({ K: label }, vault)).toEqual({ K: "coord-value" });

        // An admin later creates a different secret under the same label.
        await vault.create("toctou-label-358", "admin-value", "project", {
          createdById: "u-admin",
        });
        await expect(resolveVaultRef(label, vault)).rejects.toMatchObject({
          code: "VAULT_REF_AMBIGUOUS",
        });
        await expect(expandVaultRefs({ K: label }, vault)).rejects.toThrow(/ambiguous/i);
        // A scope-qualified reference still names exactly one row.
        expect(await resolveVaultRef(ref("global:toctou-label-358"), vault)).toBe("coord-value");
        expect(await expandVaultRefs({ K: ref("project:toctou-label-358") }, vault)).toEqual({
          K: "admin-value",
        });
      });
    });
  },
);
