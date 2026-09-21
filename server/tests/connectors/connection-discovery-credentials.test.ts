/**
 * Tests for credential extraction in connection-discovery.ts —
 * Epic #701 / Issue #703.
 *
 * Verifies:
 *  1. Credential extraction OFF unless project.allowCredentialScan === true.
 *  2. When enabled, passwords are persisted into the vault (not the DB row).
 *  3. Re-running discovery with the same password REUSES the existing vault
 *     secret (no extra rows).
 *  4. Re-running with a different password ROTATES the existing vault row
 *     (vault row id is preserved).
 *  5. An audit entry is emitted that never includes the plaintext password.
 *  6. Production-pattern files NEVER yield credentials, even when the flag
 *     is on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- Mocks ----------------------------------------------------------------

const upserted: Record<string, unknown>[] = [];
const existingRows: Map<string, { id: string; passwordVaultRef: string | null }> = new Map();

const vaultCreate = vi.fn();
const vaultRotate = vi.fn();
const vaultRead = vi.fn();

const auditCalls: Record<string, unknown>[] = [];

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async () => ({ allowCredentialScan: true })),
    },
    suggestedConnector: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { projectId_driverType_host_port_database: Record<string, unknown> };
        }) => {
          const k = JSON.stringify(where.projectId_driverType_host_port_database);
          return existingRows.get(k) ?? null;
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { projectId_driverType_host_port_database: Record<string, unknown> };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const k = JSON.stringify(where.projectId_driverType_host_port_database);
          const prior = existingRows.get(k);
          const id = prior?.id ?? `sc_${existingRows.size + 1}`;
          const row = { id, ...create, ...(prior ? update : {}) };
          upserted.push(row);
          existingRows.set(k, {
            id,
            passwordVaultRef: (row.passwordVaultRef as string | null) ?? null,
          });
          return row;
        },
      ),
    },
  },
}));

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: logWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({
    create: vaultCreate,
    rotate: vaultRotate,
    read: vaultRead,
  }),
}));

vi.mock("../../src/lib/audit/audit-service.js", () => ({
  audit: (input: Record<string, unknown>) => {
    auditCalls.push(input);
  },
}));

import { discoverAndUpsertConnections } from "../../src/lib/connectors/repo/connection-discovery.js";

let tmpDir: string;

async function writeFile(relPath: string, content: string) {
  const fullPath = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

describe("discoverAndUpsertConnections — credential extraction (#703)", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "metis-cred-discovery-"));
    upserted.length = 0;
    auditCalls.length = 0;
    existingRows.clear();
    vaultCreate.mockReset().mockImplementation(async (label: string) => ({
      id: `vault_${label.slice(-6)}`,
    }));
    vaultRotate.mockReset().mockImplementation(async (id: string) => ({ id }));
    vaultRead.mockReset();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a vault secret for newly discovered dev credentials", async () => {
    await writeFile(
      "application-dev.properties",
      [
        "spring.datasource.url=jdbc:postgresql://db-host:5432/appdb",
        "spring.datasource.username=alice",
        "spring.datasource.password=hunter2",
      ].join("\n"),
    );

    await discoverAndUpsertConnections("proj-A", tmpDir);

    expect(vaultCreate).toHaveBeenCalledTimes(1);
    const [label, plaintext, scope, opts] = vaultCreate.mock.calls[0]!;
    expect(label).toMatch(/^discovered-cred:project:proj-A:/);
    expect(plaintext).toBe("hunter2");
    expect(scope).toBe("project");
    expect(opts).toMatchObject({
      description: expect.stringContaining("application-dev.properties"),
    });

    expect(upserted[0]).toMatchObject({
      username: "alice",
      devCredsDetected: true,
      credentialSourceFile: "application-dev.properties",
      passwordVaultRef: expect.stringMatching(/^vault_/),
    });
  });

  it("never extracts credentials when allowCredentialScan is false", async () => {
    const prisma = (await import("../../src/lib/prisma.js")).prisma as unknown as {
      project: { findUnique: ReturnType<typeof vi.fn> };
    };
    prisma.project.findUnique.mockResolvedValueOnce({ allowCredentialScan: false });

    await writeFile(
      "application-dev.properties",
      [
        "spring.datasource.url=jdbc:postgresql://db-host:5432/appdb",
        "spring.datasource.username=alice",
        "spring.datasource.password=hunter2",
      ].join("\n"),
    );

    await discoverAndUpsertConnections("proj-B", tmpDir);

    expect(vaultCreate).not.toHaveBeenCalled();
    expect(upserted[0]).toMatchObject({ devCredsDetected: false });
    expect(upserted[0]).not.toHaveProperty("username", "alice");
    expect(auditCalls).toEqual([]);
  });

  it("reuses an existing vault secret when password is unchanged", async () => {
    // Seed: an existing suggestion with a vault ref already on disk.
    existingRows.set(
      JSON.stringify({
        projectId: "proj-C",
        driverType: "postgresql",
        host: "db-host",
        port: 5432,
        database: "appdb",
      }),
      { id: "sc_pre", passwordVaultRef: "vault_old" },
    );
    vaultRead.mockResolvedValue({
      summary: { id: "vault_old" },
      plaintext: "hunter2",
    });

    await writeFile(
      "application-dev.properties",
      [
        "spring.datasource.url=jdbc:postgresql://db-host:5432/appdb",
        "spring.datasource.username=alice",
        "spring.datasource.password=hunter2",
      ].join("\n"),
    );

    await discoverAndUpsertConnections("proj-C", tmpDir);

    expect(vaultRead).toHaveBeenCalledWith("vault_old");
    expect(vaultRotate).not.toHaveBeenCalled();
    expect(vaultCreate).not.toHaveBeenCalled();
    expect(auditCalls.at(-1)?.metadata).toMatchObject({ vaultMutation: "reused" });
  });

  it("rotates the vault secret when password changes", async () => {
    existingRows.set(
      JSON.stringify({
        projectId: "proj-D",
        driverType: "postgresql",
        host: "db-host",
        port: 5432,
        database: "appdb",
      }),
      { id: "sc_pre", passwordVaultRef: "vault_old" },
    );
    vaultRead.mockResolvedValue({
      summary: { id: "vault_old" },
      plaintext: "old-password",
    });

    await writeFile(
      "application-dev.properties",
      [
        "spring.datasource.url=jdbc:postgresql://db-host:5432/appdb",
        "spring.datasource.username=alice",
        "spring.datasource.password=new-password",
      ].join("\n"),
    );

    await discoverAndUpsertConnections("proj-D", tmpDir);

    expect(vaultRotate).toHaveBeenCalledWith("vault_old", "new-password");
    expect(vaultCreate).not.toHaveBeenCalled();
    expect(auditCalls.at(-1)?.metadata).toMatchObject({ vaultMutation: "rotated" });
  });

  it("audit entry never includes the plaintext password", async () => {
    await writeFile(
      "application-dev.properties",
      [
        "spring.datasource.url=jdbc:postgresql://db-host:5432/appdb",
        "spring.datasource.username=alice",
        "spring.datasource.password=hunter2",
      ].join("\n"),
    );

    await discoverAndUpsertConnections("proj-E", tmpDir);

    expect(auditCalls.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(auditCalls);
    expect(serialised).not.toContain("hunter2");
    expect(serialised).toContain("suggested_connector.credential_discovered");
  });

  it("never extracts credentials from production-pattern files", async () => {
    await writeFile(
      ".env.production",
      [
        "DATABASE_URL=postgresql://prod-host:5432/proddb",
        "DB_USER=prod_user",
        "DB_PASSWORD=top-secret",
      ].join("\n"),
    );

    await discoverAndUpsertConnections("proj-F", tmpDir);

    expect(vaultCreate).not.toHaveBeenCalled();
    expect(auditCalls).toEqual([]);
    if (upserted.length > 0) {
      expect(upserted[0]).toMatchObject({ devCredsDetected: false });
    }
  });

  it("does NOT leak the plaintext password into log output on upsert failure", async () => {
    const prisma = (await import("../../src/lib/prisma.js")).prisma as unknown as {
      suggestedConnector: { upsert: ReturnType<typeof vi.fn> };
    };
    prisma.suggestedConnector.upsert.mockRejectedValueOnce(new Error("simulated db failure"));

    await writeFile(
      "application-dev.properties",
      [
        "spring.datasource.url=jdbc:postgresql://db-host:5432/appdb",
        "spring.datasource.username=alice",
        "spring.datasource.password=hunter2",
      ].join("\n"),
    );

    await discoverAndUpsertConnections("proj-G", tmpDir);

    // The route logged the failure...
    expect(logWarn).toHaveBeenCalled();
    // ...but the plaintext password (or the username) never appears in any
    // logged payload. This is the PR #707 / OWASP A09 regression guard:
    // previously the whole `conn` object \u2014 including parsed credentials \u2014
    // was passed straight to the logger.
    const serialised = JSON.stringify(logWarn.mock.calls);
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain("password");
  });
});
