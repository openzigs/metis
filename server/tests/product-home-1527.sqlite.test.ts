/**
 * #1527 — a product records its HOME workspace, and an attached repo opens the
 * product only when the repo's project is in that workspace (or in none).
 *
 * #1259 judged the same thing at read time, from the creator's CURRENT
 * memberships and role, which left three findings (PR #1525's review):
 *   1. an admin creator "could attach" every repo, so an admin-created product
 *      opened to every workspace one of its repos sat in;
 *   2. removing the creator from the workspace (or demoting an admin creator)
 *      closed every product they made to the whole team, without warning;
 *   3. `GET /api/products` loaded every `ProductRepo` link in the caller's
 *      reachable projects and bound the product ids back into the list query.
 *
 * Decision for (2): record the workspace at attach time. The home is written
 * once, when the first repo the creator could have attached is attached, and
 * never moves, so the team keeps the product whatever later happens to the
 * creator. The migration backfills existing products the same way.
 *
 * Real SQLite built by the migration chain, real routers, services and JWTs;
 * the audit sink is a double.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

const { productsRouter } = await import("../src/routes/products-multi.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const MIGRATION = "20261104001527_issue1527_product_home_workspace";
const isSqlite = readGeneratedClientProvider() === "sqlite";

const WS1 = "ws1-1527";
const WS2 = "ws2-1527";
const PA = "proj-a-1527";
const PB = "proj-b-1527";
const PL = "proj-legacy-1527";

interface Person {
  role: RoleKey;
  ws: string[];
  /** Where the role row came from (`UserRole.source`). */
  source?: string;
  authority?: string;
}
const PEOPLE: Record<string, Person> = {
  alice: { role: "coordinator", ws: [WS1] },
  bob: { role: "coordinator", ws: [WS1] },
  carol: { role: "coordinator", ws: [WS1, WS2] },
  carl: { role: "coordinator", ws: [WS1] },
  mallory: { role: "coordinator", ws: [WS2] },
  ada: { role: "admin", ws: [] },
  dana: { role: "admin", ws: [] },
  // An IdP-granted admin with no explicit override: the login path makes her admin.
  pam: { role: "admin", ws: [], source: "provider" },
  // An IdP admin row overridden by an explicit role authority: not an admin.
  olive: { role: "admin", ws: [], source: "provider", authority: "explicit" },
};

/** Users, workspaces, three projects (ws1, ws2, legacy) and one repo each. */
async function seedTenants(db: PrismaClient): Promise<{ a: string; b: string; l: string }> {
  for (const key of ["coordinator", "admin"]) {
    await db.role.create({ data: { id: `role-${key}`, key, name: key } });
  }
  for (const ws of [WS1, WS2]) {
    await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
  }
  for (const [id, p] of Object.entries(PEOPLE)) {
    await db.user.create({
      data: {
        id,
        username: id,
        displayName: id,
        email: `${id}@example.test`,
        authRoleAuthority: p.authority ?? "unknown",
      },
    });
    await db.userRole.create({
      data: { userId: id, roleId: `role-${p.role}`, source: p.source ?? "local" },
    });
    for (const workspaceId of p.ws) {
      await db.workspaceMember.create({ data: { workspaceId, userId: id, role: "member" } });
    }
  }
  for (const [id, workspaceId] of [
    [PA, WS1],
    [PB, WS2],
    [PL, null],
  ] as const) {
    await db.project.create({
      data: { id, name: id, slug: id, createdById: "alice", workspaceId, status: "active" },
    });
  }
  const repo = async (projectId: string, key: string) =>
    (
      await db.repoConnection.create({
        data: { projectId, label: `rc-${key}`, repoName: `repo-${key}-1527`, createdById: "alice" },
      })
    ).id;
  return { a: await repo(PA, "a"), b: await repo(PB, "b"), l: await repo(PL, "l") };
}

// ── the backfill ─────────────────────────────────────────────────────────────

describe.skipIf(!isSqlite)("#1527 — the migration records each product's home workspace", () => {
  let sqlite: MigratedSqlite;
  const homes = new Map<string, string | null>();

  beforeAll(async () => {
    sqlite = createMigratedSqlite("1527-backfill", { stopBefore: MIGRATION });
    const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    let rc: { a: string; b: string; l: string };
    try {
      rc = await seedTenants(db);
    } finally {
      await db.$disconnect();
    }
    // Raw SQL: the head client would write the column the migration adds.
    let minute = 0;
    const product = (id: string, createdById: string, repos: Array<keyof typeof rc>) => {
      sqlite.exec(
        `INSERT INTO "products" ("id","name","slug","createdById","createdAt","updatedAt")
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, id, id, createdById],
      );
      for (const key of repos) {
        sqlite.exec(
          `INSERT INTO "product_repos" ("id","productId","repoConnectionId","createdAt")
           VALUES (?, ?, ?, ?)`,
          [
            `pr-${id}-${key}`,
            id,
            rc[key],
            new Date(Date.UTC(2026, 0, 1, 0, minute++)).toISOString(),
          ],
        );
      }
    };
    // The foreign repo B is attached FIRST on each of these.
    product("member", "alice", ["b", "a"]);
    product("two-workspaces", "carol", ["b", "a"]);
    product("admin", "ada", ["b", "a"]);
    product("provider-admin", "pam", ["b"]);
    product("overridden-admin", "olive", ["b"]);
    product("foreign-only", "alice", ["b"]);
    product("legacy-only", "alice", ["l"]);
    product("legacy-then-member", "alice", ["l", "a"]);
    product("empty", "alice", []);

    sqlite.apply(MIGRATION);
    sqlite.applyRemaining();
    const after = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    try {
      for (const p of await after.product.findMany({ select: { id: true, workspaceId: true } })) {
        homes.set(p.id, p.workspaceId);
      }
    } finally {
      await after.$disconnect();
    }
  }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

  afterAll(() => sqlite?.cleanup());

  it("homes a product in its creator's workspace, even when a foreign repo was attached first", () => {
    expect(homes.get("member")).toBe(WS1);
    expect(homes.get("legacy-then-member")).toBe(WS1);
  });

  it("homes a creator of two workspaces' product in the earlier-attached one", () => {
    expect(homes.get("two-workspaces")).toBe(WS2);
  });

  it("homes an admin's product in its earliest-attached repo's workspace", () => {
    expect(homes.get("admin")).toBe(WS2);
    expect(homes.get("provider-admin")).toBe(WS2);
  });

  it("leaves a product NULL when no repo its creator could attach sits in a workspace", () => {
    expect(homes.get("overridden-admin")).toBeNull();
    expect(homes.get("foreign-only")).toBeNull();
    expect(homes.get("legacy-only")).toBeNull();
    expect(homes.get("empty")).toBeNull();
  });
});

// ── the routes ───────────────────────────────────────────────────────────────

const payload = (who: string): AuthPayload => ({
  userId: who,
  username: who,
  role: PEOPLE[who].role,
  permissions: getPermissionsForRole(PEOPLE[who].role),
  workspaces: PEOPLE[who].ws,
});
const bearer = (who: string) => `Bearer ${issueTokens(payload(who)).accessToken}`;
const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/products", productsRouter());
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
};
const get = (path: string, who: string) =>
  request(app()).get(path).set("Authorization", bearer(who));
const post = (path: string, who: string, body: object) =>
  request(app()).post(path).set("Authorization", bearer(who)).send(body);

describe.skipIf(!isSqlite)("#1527 — the home is recorded on attach and decides access", () => {
  let sqlite: MigratedSqlite;
  let db: PrismaClient;
  let rc: { a: string; b: string; l: string };

  const create = async (who: string, slug: string) => {
    const res = await post("/api/products", who, { name: slug, slug: `${slug}-1527` });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };
  const attach = async (who: string, productId: string, repoConnectionId: string) => {
    const res = await post(`/api/products/${productId}/repos`, who, { repoConnectionId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };
  const home = async (productId: string) =>
    (await db.product.findUniqueOrThrow({ where: { id: productId } })).workspaceId;
  const listedIds = async (who: string) => {
    const res = await get("/api/products?pageSize=100", who);
    expect(res.status).toBe(200);
    return (res.body.data.items as Array<{ id: string }>).map((p) => p.id);
  };

  beforeAll(async () => {
    sqlite = createMigratedSqlite("1527-product-home");
    db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    state.db = db;
    rc = await seedTenants(db);
  }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    sqlite?.cleanup();
  });

  it("records the home on the first workspace repo, and a later foreign repo neither moves it nor opens the product", async () => {
    const id = await create("alice", "recorded");
    await attach("alice", id, rc.l);
    expect(await home(id)).toBeNull(); // a legacy repo homes nothing
    await attach("alice", id, rc.a);
    expect(await home(id)).toBe(WS1);
    // Carol is in both workspaces, so the attach itself is allowed (#1250).
    await attach("carol", id, rc.b);
    expect(await home(id)).toBe(WS1);
    expect((await get(`/api/products/${id}`, "bob")).status).toBe(200);
    // Mallory still reaches it through the legacy repo, which is open to all.
    expect((await get(`/api/products/${id}`, "mallory")).status).toBe(200);
    await request(app())
      .delete(`/api/products/${id}/repos/${rc.l}`)
      .set("Authorization", bearer("alice"))
      .expect(204);
    expect((await get(`/api/products/${id}`, "mallory")).status).toBe(404);
    expect(await listedIds("mallory")).not.toContain(id);
    expect(await listedIds("bob")).toContain(id);
  });

  it("an admin-created product reached only through a cross-workspace repo is 404 to the foreign workspace", async () => {
    const id = await create("ada", "admin-made");
    await attach("ada", id, rc.a);
    await attach("ada", id, rc.b);
    expect(await home(id)).toBe(WS1);
    for (const path of ["", "/analyses", "/documents"]) {
      expect((await get(`/api/products/${id}${path}`, "mallory")).status, path).toBe(404);
      expect((await get(`/api/products/${id}${path}`, "bob")).status, path).toBe(200);
    }
    expect(await listedIds("mallory")).not.toContain(id);
    expect(await listedIds("bob")).toContain(id);
  });

  it("a repo the creator could not have attached homes nothing", async () => {
    const id = await create("alice", "unbound");
    // The product is unbound, so Mallory may open it and attach her own repo (#1524).
    await attach("mallory", id, rc.b);
    expect(await home(id)).toBeNull();
    expect((await get(`/api/products/${id}`, "mallory")).status).toBe(404);
  });

  describe("the creator's later standing does not move the product (decision for finding 2)", () => {
    it("removing the creator from the workspace keeps the product with the team", async () => {
      const id = await create("carl", "carls");
      await attach("carl", id, rc.a);
      // What `DELETE /api/workspaces/:id/members/:memberId` does.
      await db.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId: WS1, userId: "carl" } },
      });
      expect((await get(`/api/products/${id}`, "bob")).status).toBe(200);
      expect(await listedIds("bob")).toContain(id);
      expect(await home(id)).toBe(WS1);
    });

    it("demoting an admin creator keeps the product with the team", async () => {
      const id = await create("dana", "danas");
      await attach("dana", id, rc.a);
      await db.userRole.deleteMany({ where: { userId: "dana" } });
      await db.userRole.create({ data: { userId: "dana", roleId: "role-coordinator" } });
      expect((await get(`/api/products/${id}`, "bob")).status).toBe(200);
      expect(await listedIds("bob")).toContain(id);
    });
  });
});

// ── the list read (finding 3) ────────────────────────────────────────────────

const PROJECTS = 1_100;
const SAFE_BINDS = 900;

describe.skipIf(!isSqlite)(
  "#1527 — GET /api/products binds nothing that grows with the tenant",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let binds: number[] = [];

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1527-product-list");
      db = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: sqlite.url }),
        log: [{ emit: "event", level: "query" }],
      });
      (db as unknown as { $on(event: "query", cb: (e: { params: string }) => void): void }).$on(
        "query",
        (e) => binds.push((JSON.parse(e.params) as unknown[]).length),
      );
      state.db = db;
      await seedTenants(db);

      // 1,100 legacy projects, open to every member: half reach their product
      // through a repo, half are bound to it directly.
      const n = (i: number) => String(i).padStart(4, "0");
      const index = Array.from({ length: PROJECTS }, (_, i) => i);
      const chunks = Array.from({ length: PROJECTS / 100 }, (_, c) =>
        index.slice(c * 100, (c + 1) * 100),
      );
      for (const part of chunks) {
        await db.product.createMany({
          data: part.map((i) => ({
            id: `prod-${n(i)}`,
            name: `p${n(i)}`,
            slug: `p-${n(i)}`,
            createdById: "alice",
          })),
        });
        await db.project.createMany({
          data: part.map((i) => ({
            id: `proj-${n(i)}`,
            name: `proj-${n(i)}`,
            slug: `proj-${n(i)}`,
            createdById: "mallory",
            productId: i % 2 ? `prod-${n(i)}` : null,
          })),
        });
        const viaRepo = part.filter((i) => i % 2 === 0);
        await db.repoConnection.createMany({
          data: viaRepo.map((i) => ({
            id: `rc-${n(i)}`,
            projectId: `proj-${n(i)}`,
            label: `rc-${n(i)}`,
            repoName: `r-${n(i)}`,
            createdById: "mallory",
          })),
        });
        await db.productRepo.createMany({
          data: viaRepo.map((i) => ({ productId: `prod-${n(i)}`, repoConnectionId: `rc-${n(i)}` })),
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("lists every product a member can reach, binding no more than a safe number of values", async () => {
      binds = [];
      const res = await get("/api/products?pageSize=20", "bob");
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(PROJECTS);
      expect(res.body.data.items).toHaveLength(20);
      expect(binds.length).toBeGreaterThan(0);
      expect(Math.max(...binds)).toBeLessThanOrEqual(SAFE_BINDS);
    });
  },
);
