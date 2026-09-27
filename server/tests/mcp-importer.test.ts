/**
 * mcp.json importer — secret routing and dryRun.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #258 — a `secret` table double that behaves like the real one: `name` is
 * UNIQUE and a soft-deleted row keeps it, reads see live rows only. The earlier
 * double returned rows the vault could not even summarise, so every create
 * threw — and the importer's catch-and-log hid that as success.
 */
interface SecretRow {
  id: string;
  name: string;
  description: string;
  ciphertext: string;
  keyVersion: number;
  algorithm: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
const created: SecretRow[] = [];
let secretSeq = 0;
let failNextCreate: Error | null = null;

function matches(row: SecretRow, where: Record<string, unknown>): boolean {
  if ("id" in where && row.id !== where.id) return false;
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  const name = where.name as { startsWith?: string } | undefined;
  if (name?.startsWith && !row.name.startsWith(name.startsWith)) return false;
  return true;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    secret: {
      create: vi.fn(async ({ data }: { data: Partial<SecretRow> & { name: string } }) => {
        if (failNextCreate) {
          const err = failNextCreate;
          failNextCreate = null;
          throw err;
        }
        if (created.some((r) => r.name === data.name)) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`name`)"), {
            code: "P2002",
          });
        }
        secretSeq += 1;
        const row: SecretRow = {
          id: `sec_${secretSeq}`,
          name: data.name,
          description: data.description ?? "",
          ciphertext: data.ciphertext ?? "",
          keyVersion: data.keyVersion ?? 1,
          algorithm: data.algorithm ?? "aes-256-gcm",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
        created.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          created.find((r) => matches(r, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        created.filter((r) => matches(r, where)).reverse(),
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<SecretRow> }) => {
          const row = created.find((r) => r.id === where.id);
          if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
          Object.assign(row, data);
          return row;
        },
      ),
    },
  },
}));

import {
  buildImportPlan,
  executeImport,
  SECRET_KEY_PATTERN,
  isSecretValue,
  isSecretHeaderName,
} from "../src/lib/mcp/mcp-importer.js";
import type { MCPRegistryService } from "../src/lib/mcp/mcp-service.js";
import { expandVaultRefs } from "../src/lib/vault/env-manager.js";
import { getVaultService } from "../src/lib/vault/vault-service.js";

beforeEach(() => {
  created.length = 0;
  secretSeq = 0;
  failNextCreate = null;
});

describe("SECRET_KEY_PATTERN", () => {
  it.each(["GITHUB_TOKEN", "API_KEY", "DB_PASSWORD", "OPENAI_SECRET", "GH_PAT"])(
    "matches %s",
    (k) => expect(SECRET_KEY_PATTERN.test(k)).toBe(true),
  );
  it.each(["FOO", "PORT", "URL", "DEBUG"])("does not match %s", (k) =>
    expect(SECRET_KEY_PATTERN.test(k)).toBe(false),
  );
  // SEC-9: extended secret-key conventions.
  it.each([
    "MY_BEARER",
    "BEARER",
    "X_CREDENTIALS",
    "DB_CREDENTIAL",
    "APIKEY",
    "FOO_AUTH",
    "MY_JWT",
    "JWT",
    "DB_PASSWD",
    "ROOT_PASSWORD",
  ])("SEC-9 matches %s", (k) => expect(SECRET_KEY_PATTERN.test(k)).toBe(true));
});

describe("isSecretValue (SEC-3 / SEC-9 value-shape detection)", () => {
  it.each([
    "Bearer abcdef1234567890XYZ",
    "Basic dXNlcjpwYXNzd29yZA==",
    "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "github_pat_11AAAAAAA0AAAAA00AAAAAA",
    "xoxb-1234567890-AAAAAAA",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-aaaaaaaaaaaaaaaaaaaaaaa",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ])("flags secret-shaped value %s", (v) => expect(isSecretValue(v)).toBe(true));
  it.each(["debug", "json", "Bearer ", "${vault:abc}", "x", "1234"])(
    "does not flag mundane value %s",
    (v) => expect(isSecretValue(v)).toBe(false),
  );
});

describe("isSecretHeaderName (SEC-3)", () => {
  it.each([
    "Authorization",
    "authorization",
    "X-Api-Key",
    "PRIVATE-TOKEN",
    "Cookie",
    "Proxy-Authorization",
    "Bearer",
  ])("flags %s", (n) => expect(isSecretHeaderName(n)).toBe(true));
  it.each(["X-Trace-Id", "Accept", "Content-Type"])("ignores %s", (n) =>
    expect(isSecretHeaderName(n)).toBe(false),
  );
});

describe("buildImportPlan", () => {
  it("rewrites secret-keyed env vars to vault refs", async () => {
    const raw = {
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@mcp/github"],
          env: { GITHUB_TOKEN: "ghp_real", LOG_LEVEL: "debug" },
        },
      },
    };
    const plan = await buildImportPlan(raw);
    expect(plan.totalSecrets).toBe(1);
    const e = plan.entries[0];
    expect(e.env.GITHUB_TOKEN).toMatch(/^\$\{vault:mcp-github-github_token\}$/);
    expect(e.env.LOG_LEVEL).toBe("debug");
    // Plaintext NEVER persisted on plan
    expect(JSON.stringify(plan)).not.toContain("ghp_real");
  });

  it("infers transport from url when type missing", async () => {
    const plan = await buildImportPlan({
      servers: { remote: { url: "https://x/y", headers: { X: "y" } } },
    });
    expect(plan.entries[0].transport).toBe("http");
  });

  it("supports labelPrefix for de-collision", async () => {
    const plan = await buildImportPlan(
      { mcpServers: { gh: { command: "npx" } } },
      { labelPrefix: "team-a" },
    );
    expect(plan.entries[0].label).toBe("team-a-gh");
  });

  // SEC-3: header values must be vaulted on import too.
  it("vaults Authorization header values into refs", async () => {
    const raw = {
      mcpServers: {
        remote: {
          url: "https://api.example.com/mcp",
          headers: {
            Authorization: "Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAA",
            "X-Trace-Id": "trace-12",
          },
        },
      },
    };
    const plan = await buildImportPlan(raw);
    const e = plan.entries[0];
    expect(e.headers).toBeTruthy();
    expect(e.headers!.Authorization).toMatch(/^\$\{vault:mcp-remote-header-authorization\}$/);
    expect(e.headers!["X-Trace-Id"]).toBe("trace-12");
    expect(e.vaultedHeaders.Authorization).toBe("mcp-remote-header-authorization");
    expect(plan.totalSecrets).toBe(1);
    expect(JSON.stringify(plan)).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("vaults env values that LOOK like secrets even when key is innocuous (SEC-3)", async () => {
    const raw = {
      mcpServers: {
        srv: {
          command: "node",
          env: { OPTIONS: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaa" },
        },
      },
    };
    const plan = await buildImportPlan(raw);
    expect(plan.entries[0].env.OPTIONS).toMatch(/^\$\{vault:mcp-srv-options\}$/);
    expect(plan.totalSecrets).toBe(1);
  });
});

describe("executeImport", () => {
  type CreateInput = {
    label: string;
    env: Record<string, string>;
    headers?: Record<string, string>;
    envSecretRefs: Record<string, string>;
  };
  function fakeRegistry() {
    const reg = {
      create: vi.fn(async (input: CreateInput) => ({
        id: `mcp_${input.label}`,
        label: input.label,
      })),
    };
    return reg as typeof reg & MCPRegistryService;
  }
  /** What a server registered by this import actually resolves at spawn time. */
  function resolvedEnv(reg: ReturnType<typeof fakeRegistry>, call: number) {
    return expandVaultRefs(reg.create.mock.calls[call][0].env, getVaultService());
  }

  it("dryRun does not write anything", async () => {
    const reg = fakeRegistry();
    const r = await executeImport(
      { mcpServers: { x: { command: "node", env: { API_KEY: "abc" } } } },
      reg,
      { id: "u1" },
      { dryRun: true },
    );
    expect(r.dryRun).toBe(true);
    expect(r.created).toHaveLength(0);
    expect(reg.create).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("creates vault secrets and MCPServer rows", async () => {
    const reg = fakeRegistry();
    const r = await executeImport(
      { mcpServers: { gh: { command: "npx", env: { GITHUB_TOKEN: "ghp_X" } } } },
      reg,
      { id: "u1" },
    );
    expect(r.errors).toHaveLength(0);
    expect(r.created).toHaveLength(1);
    expect(created).toHaveLength(1);
    // Stored ciphertext should not equal plaintext
    expect(created[0].ciphertext).not.toContain("ghp_X");
    // The registered env is a ref, and it resolves to the imported value.
    const input = reg.create.mock.calls[0][0];
    expect(input.env.GITHUB_TOKEN).toMatch(/^\$\{vault:mcp-gh-github_token-[0-9A-Z]{26}\}$/);
    expect(input.envSecretRefs.GITHUB_TOKEN).toBe(created[0].name.replace(/^global:/, ""));
    expect((await resolvedEnv(reg, 0)).GITHUB_TOKEN).toBe("ghp_X");
  });

  it("a re-import with a NEW value is what the new server resolves, never the old secret (#258)", async () => {
    const reg = fakeRegistry();
    const first = await executeImport(
      { mcpServers: { gh: { command: "npx", env: { GITHUB_TOKEN: "ghp_OLD" } } } },
      reg,
      { id: "u1" },
    );
    expect(first.errors).toHaveLength(0);

    const second = await executeImport(
      {
        mcpServers: {
          gh: {
            url: "https://mcp.example.test",
            env: { GITHUB_TOKEN: "ghp_NEW" },
            headers: { Authorization: "Bearer NEW-bearer-value" },
          },
        },
      },
      reg,
      { id: "u1" },
    );

    expect(second.errors).toHaveLength(0);
    expect((await resolvedEnv(reg, 1)).GITHUB_TOKEN).toBe("ghp_NEW");
    const headers = reg.create.mock.calls[1][0].headers!;
    expect((await expandVaultRefs(headers, getVaultService())).Authorization).toBe(
      "Bearer NEW-bearer-value",
    );
    // The first server still resolves its own value.
    expect((await resolvedEnv(reg, 0)).GITHUB_TOKEN).toBe("ghp_OLD");
  });

  it("a vault failure fails the entry instead of reporting success (#258)", async () => {
    const reg = fakeRegistry();
    failNextCreate = new Error("disk full");
    const r = await executeImport(
      { mcpServers: { gh: { command: "npx", env: { GITHUB_TOKEN: "ghp_X" } } } },
      reg,
      { id: "u1" },
    );
    expect(r.created).toHaveLength(0);
    expect(r.errors).toEqual([{ label: "gh", message: "disk full" }]);
    expect(reg.create).not.toHaveBeenCalled();
  });

  it("captures registry create errors per entry and withdraws the secrets it wrote", async () => {
    const reg = {
      create: vi.fn(async () => {
        throw new Error("dup");
      }),
    } as unknown as MCPRegistryService;
    const r = await executeImport(
      { mcpServers: { x: { command: "node", env: { API_KEY: "abc-secret" } } } },
      reg,
      { id: "u1" },
    );
    expect(r.created).toHaveLength(0);
    expect(r.errors[0].message).toBe("dup");
    expect(created).toHaveLength(1);
    expect(created[0].deletedAt).not.toBeNull();
  });
});
