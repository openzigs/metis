/**
 * Issue #257 — integration tests for the unified `/api/admin/config` REST surface.
 *
 * Mirrors the Phase 1 test mocks (in-memory prisma stand-ins for `secret`,
 * `configAudit`, `runtimeConfig`, `user`) and walks the full happy/RBAC/tier
 * matrix. The Phase 2 surface adds GET list/get + tunable PUT/DELETE on top
 * of the Phase 1 secret-only behaviour, so the test suite is rebuilt from
 * scratch rather than amended.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface AuditRow {
  id: string;
  key: string;
  oldValueRedacted: string;
  newValueRedacted: string;
  actorId: string;
  scope: string;
  ts: Date;
}
interface SecretRow {
  id: string;
  name: string;
  description: string;
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
  keyVersion: number;
  algorithm: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
interface RuntimeConfigRow {
  key: string;
  value: string;
  valueType: string;
  scope: string;
  updatedById: string;
  updatedAt: Date;
}

const auditRows: AuditRow[] = [];
const secretRows: SecretRow[] = [];
const runtimeRows: RuntimeConfigRow[] = [];
let nextSecretId = 1;
let nextAuditId = 1;

/**
 * #93 — the error Prisma raises on a unique-index violation, shaped as the
 * client raises it: its class name, `code: "P2002"`, and the raw invocation
 * text that must never reach an API response.
 */
function prismaUniqueError(op: string): Error {
  const err = new Error(
    `Invalid \`prisma.${op}()\` invocation in server/src/lib/vault/vault-service.ts:254\n\n` +
      "Unique constraint failed on the fields: (`name`)",
  ) as Error & { code: string; clientVersion: string; meta: unknown };
  err.name = "PrismaClientKnownRequestError";
  err.code = "P2002";
  err.clientVersion = "7.8.0";
  err.meta = { target: ["name"] };
  return err;
}

vi.mock("../../../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("../../helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({
          id: `user_${create.username}`,
          ...create,
        }),
      ),
      findUnique: vi.fn(async ({ where }: { where: { username?: string; id?: string } }) => ({
        id: `user_${where.username ?? where.id}`,
        username: where.username ?? "x",
        displayName: where.username ?? "x",
        email: `${where.username ?? "x"}@x`,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: { findMany: vi.fn(async () => []) },
    secret: {
      // #93 — `Secret.name` is UNIQUE in the schema, soft-deleted rows included.
      // This double used to accept a duplicate name, which is how a re-set after
      // a clear passed here while it 500'd against a real database.
      create: vi.fn(async ({ data }: { data: Partial<SecretRow> }) => {
        if (secretRows.some((r) => r.name === data.name)) throw prismaUniqueError("secret.create");
        const row: SecretRow = {
          id: `sec_${nextSecretId++}`,
          name: data.name ?? "",
          description: data.description ?? "",
          ciphertext: data.ciphertext ?? "",
          iv: data.iv ?? "",
          tag: data.tag ?? "",
          salt: data.salt ?? "",
          keyVersion: data.keyVersion ?? 1,
          algorithm: data.algorithm ?? "aes-256-gcm",
          createdById: data.createdById ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
        secretRows.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string; deletedAt: null } }) =>
          secretRows.find((r) => r.id === where.id && r.deletedAt === null) ?? null,
      ),
      findMany: vi.fn(
        async ({ where }: { where: { deletedAt: null; name?: { startsWith: string } } }) =>
          secretRows.filter((r) => {
            if (r.deletedAt !== null) return false;
            if (where.name?.startsWith) return r.name.startsWith(where.name.startsWith);
            return true;
          }),
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<SecretRow> }) => {
          const row = secretRows.find((r) => r.id === where.id);
          if (!row) throw new Error("not found");
          Object.assign(row, data, { updatedAt: new Date() });
          return row;
        },
      ),
      // #93 — modelled as Prisma's NON-native upsert: a read, a gap, then a
      // create that the unique index can still refuse. Two concurrent callers
      // can both miss the read, and the loser gets P2002 — the race the vault
      // must absorb rather than surface.
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { name: string };
          create: Partial<SecretRow>;
          update: Partial<SecretRow>;
        }) => {
          const existing = secretRows.find((r) => r.name === where.name);
          if (existing) {
            Object.assign(existing, update, { updatedAt: new Date() });
            return existing;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (secretRows.some((r) => r.name === create.name)) {
            throw prismaUniqueError("secret.upsert");
          }
          const row: SecretRow = {
            id: `sec_${nextSecretId++}`,
            name: create.name ?? "",
            description: create.description ?? "",
            ciphertext: create.ciphertext ?? "",
            iv: create.iv ?? "",
            tag: create.tag ?? "",
            salt: create.salt ?? "",
            keyVersion: create.keyVersion ?? 1,
            algorithm: create.algorithm ?? "aes-256-gcm",
            createdById: create.createdById ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          };
          secretRows.push(row);
          return row;
        },
      ),
    },
    runtimeConfig: {
      findMany: vi.fn(async () => [...runtimeRows]),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { key: string };
          create: RuntimeConfigRow;
          update: Partial<RuntimeConfigRow>;
        }) => {
          const existing = runtimeRows.find((r) => r.key === where.key);
          if (existing) {
            Object.assign(existing, update, { updatedAt: new Date() });
            return existing;
          }
          const row: RuntimeConfigRow = { ...create, updatedAt: new Date() };
          runtimeRows.push(row);
          return row;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => {
        const idx = runtimeRows.findIndex((r) => r.key === where.key);
        if (idx >= 0) runtimeRows.splice(idx, 1);
        return { count: 1 };
      }),
    },
    configAudit: {
      create: vi.fn(async ({ data }: { data: Partial<AuditRow> }) => {
        const row: AuditRow = {
          id: `aud_${nextAuditId++}`,
          key: data.key ?? "",
          oldValueRedacted: data.oldValueRedacted ?? "",
          newValueRedacted: data.newValueRedacted ?? "",
          actorId: data.actorId ?? "",
          scope: data.scope ?? "global",
          ts: new Date(),
        };
        auditRows.push(row);
        return row;
      }),
      findMany: vi.fn(
        async ({
          take,
          cursor,
          skip,
        }: {
          take: number;
          cursor?: { id: string };
          skip?: number;
        }) => {
          let sorted = [...auditRows].sort((a, b) => b.ts.getTime() - a.ts.getTime());
          if (cursor) {
            const idx = sorted.findIndex((r) => r.id === cursor.id);
            if (idx >= 0) sorted = sorted.slice(idx + (skip ?? 0));
          }
          return sorted.slice(0, take);
        },
      ),
    },
  });
  return { prisma };
});

vi.mock("../../../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import request from "supertest";
import { createApp } from "../../../src/app.js";
import { __resetConfigSingleton } from "../../../src/lib/config/index.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  app = createApp();
  auditRows.length = 0;
  secretRows.length = 0;
  runtimeRows.length = 0;
  nextAuditId = 1;
  nextSecretId = 1;
  __resetConfigSingleton();
});

afterEach(() => {
  vi.clearAllMocks();
  __resetConfigSingleton();
});

describe("GET /api/admin/config", () => {
  it("requires admin.read", async () => {
    const res = await request(app).get("/api/admin/config");
    expect(res.status).toBe(401);

    const reader = await login("reader");
    const res2 = await request(app)
      .get("/api/admin/config")
      .set("Authorization", `Bearer ${reader}`);
    expect(res2.status).toBe(403);
  });

  it("lists all registered keys with redacted secret values and source info", async () => {
    const token = await login("admin");
    const res = await request(app).get("/api/admin/config").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items: Array<{ key: string; tier: string; sensitive: boolean; value: string | null }> =
      res.body.data.items;
    // We expose all bootstrap, secret, tunable keys.
    const openai = items.find((i) => i.key === "OPENAI_API_KEY");
    expect(openai?.tier).toBe("secret");
    // Secret values are NEVER returned in plaintext.
    expect(openai?.value === null || openai?.value === "[REDACTED]").toBe(true);
    const dburl = items.find((i) => i.key === "DATABASE_URL");
    expect(dburl?.tier).toBe("bootstrap");
  });
});

describe("GET /api/admin/config/:key", () => {
  it("returns 400 for unknown keys", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/admin/config/SOMETHING_WEIRD")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_KEY");
  });

  it("returns the redacted projection for a registered key", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/admin/config/AI_DEFAULT_MODEL")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.key).toBe("AI_DEFAULT_MODEL");
    expect(res.body.data.tier).toBe("tunable");
  });
});

describe("PUT /api/admin/config/:key — secrets", () => {
  it("creates a vault entry and audits as [REDACTED]", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/OPENAI_API_KEY")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "sk-fresh" });
    expect(res.status).toBe(200);
    expect(secretRows).toHaveLength(1);
    expect(auditRows[0].newValueRedacted).toBe("[REDACTED]");
    expect(JSON.stringify(auditRows[0])).not.toContain("sk-fresh");
  });

  it("rotates an existing secret on subsequent write", async () => {
    const token = await login("admin");
    await request(app)
      .put("/api/admin/config/ANTHROPIC_API_KEY")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "sk-ant-1" });
    const res = await request(app)
      .put("/api/admin/config/ANTHROPIC_API_KEY")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "sk-ant-2" });
    expect(res.status).toBe(200);
    expect(secretRows).toHaveLength(1);
    expect(auditRows).toHaveLength(2);
  });

  it("rejects empty secret values via the per-key Zod schema", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/GITHUB_TOKEN")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VALUE");
  });
});

describe("PUT /api/admin/config/:key — tunables", () => {
  it("upserts runtime_config and audits the new value", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/AI_DEFAULT_MODEL")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "gpt-4o" });
    expect(res.status).toBe(200);
    expect(runtimeRows).toHaveLength(1);
    expect(runtimeRows[0].value).toBe("gpt-4o");
    expect(auditRows[0].newValueRedacted).toBe("gpt-4o");
  });

  it("rejects unknown enum values for AI_PROVIDER", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/AI_PROVIDER")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "magic-cloud" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VALUE");
  });

  it("rejects negative integers for PUBLISH_RATE_LIMIT_DELAY_MS", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/PUBLISH_RATE_LIMIT_DELAY_MS")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VALUE");
  });

  it("rejects malformed hostname entries in DB_ALLOWED_HOSTS", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/DB_ALLOWED_HOSTS")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "ok.com,not a host,also.fine" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VALUE");
  });

  it("accepts a comma-separated hostname list", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/REPO_ALLOWED_HOSTS")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "github.com, gitlab.example.org" });
    expect(res.status).toBe(200);
    expect(runtimeRows[0].value).toBe("github.com,gitlab.example.org");
  });
});

describe("PUT /api/admin/config/:key — boundaries", () => {
  it("requires admin.write", async () => {
    const reader = await login("reader");
    const res = await request(app)
      .put("/api/admin/config/AI_DEFAULT_MODEL")
      .set("Authorization", `Bearer ${reader}`)
      .send({ value: "gpt-4o" });
    expect(res.status).toBe(403);
  });

  it("rejects bootstrap keys", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/JWT_SECRET")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BOOTSTRAP_KEY");
  });

  it("rejects unknown keys", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/SOMETHING_NEW")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_KEY");
  });
});

/**
 * #93 — setting a config secret could answer 500 with a raw Prisma
 * unique-constraint error. `setSecret` chose between create and rotate from a
 * prior `list()`, which filters out soft-deleted rows — so a secret that had
 * been cleared was invisible to the read and fatal to the create.
 */
describe("PUT /api/admin/config/:key — #93 idempotent secret writes", () => {
  const RAW_PRISMA = /prisma|Unique constraint|P2002|invocation/i;

  it("re-sets a secret that was cleared (the row exists, the pre-read missed it)", async () => {
    const token = await login("admin");
    const put = (value: string) =>
      request(app)
        .put("/api/admin/config/GITHUB_TOKEN")
        .set("Authorization", `Bearer ${token}`)
        .send({ value });

    expect((await put("gho_first")).status).toBe(200);
    const cleared = await request(app)
      .delete("/api/admin/config/GITHUB_TOKEN")
      .set("Authorization", `Bearer ${token}`);
    expect(cleared.status).toBe(200);

    const again = await put("gho_second");
    expect(again.status).toBe(200);
    expect(JSON.stringify(again.body)).not.toMatch(RAW_PRISMA);
    // One row, live again — not a second row, and not still soft-deleted.
    expect(secretRows).toHaveLength(1);
    expect(secretRows[0].deletedAt).toBeNull();

    // Read back through the route a consumer uses: the vault is the source again.
    const read = await request(app)
      .get("/api/admin/config/GITHUB_TOKEN")
      .set("Authorization", `Bearer ${token}`);
    expect(read.body.data.source).toBe("vault");
  });

  it("accepts two concurrent first writes of the same secret", async () => {
    const token = await login("admin");
    const put = (value: string) =>
      request(app)
        .put("/api/admin/config/ANTHROPIC_API_KEY")
        .set("Authorization", `Bearer ${token}`)
        .send({ value });

    const [a, b] = await Promise.all([put("sk-ant-a"), put("sk-ant-b")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(JSON.stringify([a.body, b.body])).not.toMatch(RAW_PRISMA);
    expect(secretRows).toHaveLength(1);
  });

  it("maps a persistent unique violation to 409 in fixed vocabulary", async () => {
    const { prisma } = await import("../../../src/lib/prisma.js");
    const secret = (prisma as unknown as { secret: { upsert: () => unknown } }).secret;
    // Once per attempt: the vault retries a lost race exactly once. `Once` keeps
    // the double's real implementation for every later test.
    vi.spyOn(secret, "upsert")
      .mockRejectedValueOnce(prismaUniqueError("secret.upsert"))
      .mockRejectedValueOnce(prismaUniqueError("secret.upsert"));

    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/OPENAI_API_KEY")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "sk-x" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFIG_WRITE_CONFLICT");
    expect(JSON.stringify(res.body)).not.toMatch(RAW_PRISMA);
  });

  it("maps any other database error to a fixed 500, never its text", async () => {
    const { prisma } = await import("../../../src/lib/prisma.js");
    const secret = (prisma as unknown as { secret: { upsert: () => unknown } }).secret;
    const dbErr = Object.assign(
      new Error("Invalid `prisma.secret.upsert()` invocation: Can't reach database server"),
      { name: "PrismaClientInitializationError" },
    );
    vi.spyOn(secret, "upsert").mockRejectedValueOnce(dbErr);

    const token = await login("admin");
    const res = await request(app)
      .put("/api/admin/config/OPENAI_API_KEY")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "sk-x" });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("CONFIG_STORE_ERROR");
    expect(JSON.stringify(res.body)).not.toMatch(RAW_PRISMA);
  });
});

describe("DELETE /api/admin/config/:key", () => {
  it("clears a vault secret and audits the change", async () => {
    const token = await login("admin");
    await request(app)
      .put("/api/admin/config/GITHUB_TOKEN")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "gho_xxx" });
    const res = await request(app)
      .delete("/api/admin/config/GITHUB_TOKEN")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(secretRows[0].deletedAt).not.toBeNull();
    expect(auditRows).toHaveLength(2);
  });

  it("clears a tunable override and audits", async () => {
    const token = await login("admin");
    await request(app)
      .put("/api/admin/config/SCHEDULER_TICK_INTERVAL_MS")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: 5000 });
    const res = await request(app)
      .delete("/api/admin/config/SCHEDULER_TICK_INTERVAL_MS")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(runtimeRows).toHaveLength(0);
    expect(auditRows).toHaveLength(2);
    expect(auditRows[1].newValueRedacted).toBe("[unset]");
  });
});

describe("GET /api/admin/config/audit", () => {
  it("returns rows newest-first", async () => {
    const token = await login("admin");
    await request(app)
      .put("/api/admin/config/OPENAI_API_KEY")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "sk-1" });
    await request(app)
      .put("/api/admin/config/AI_DEFAULT_MODEL")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "claude-sonnet-4.5" });
    const res = await request(app)
      .get("/api/admin/config/audit?limit=10")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
  });

  it("rejects an out-of-range limit", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/admin/config/audit?limit=99999")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_QUERY");
  });
});
