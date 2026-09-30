/**
 * #482 — the owner/bindings description and refusal message, over every
 * resource kind and the fallbacks a sparse row takes. The route-level proof
 * against a real database is `tests/vault-rotate-foreign-owner-482.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  databaseConnection: { findMany: vi.fn() },
  repoConnection: { findMany: vi.fn() },
  importSource: { findMany: vi.fn() },
  mCPServer: { findMany: vi.fn() },
  jiraConnection: { findMany: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));

const { describeForeignOwner, foreignOwnerMessage } = await import("./rotate-foreign-owner.js");

beforeEach(() => {
  for (const model of Object.values(db)) {
    for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  db.user.findUnique.mockResolvedValue(null);
  for (const m of [
    db.databaseConnection,
    db.repoConnection,
    db.importSource,
    db.mCPServer,
    db.jiraConnection,
  ]) {
    m.findMany.mockResolvedValue([]);
  }
});

describe("describeForeignOwner", () => {
  it("queries every binding column by the secret id, live rows only", async () => {
    await describeForeignOwner({ id: "sec-1", createdById: "u-1" });
    expect(db.databaseConnection.findMany.mock.calls[0]![0].where).toEqual({
      secretId: "sec-1",
      deletedAt: null,
    });
    expect(db.repoConnection.findMany.mock.calls[0]![0].where).toEqual({
      secretId: "sec-1",
      deletedAt: null,
    });
    expect(db.importSource.findMany.mock.calls[0]![0].where).toEqual({
      secretId: "sec-1",
      deletedAt: null,
    });
    expect(db.mCPServer.findMany.mock.calls[0]![0].where).toEqual({
      envSecretId: "sec-1",
      deletedAt: null,
    });
    expect(db.jiraConnection.findMany.mock.calls[0]![0].where).toEqual({
      deletedAt: null,
      OR: [{ secretId: "sec-1" }, { tlsCaSecretId: "sec-1" }],
    });
  });

  it("falls back to the driver, provider, source and command when no host or URL is set", async () => {
    db.databaseConnection.findMany.mockResolvedValue([
      { id: "d1", label: "Local", projectId: "p", driver: "sqlite", host: null, port: null },
      { id: "d2", label: "NoPort", projectId: "p", driver: "mysql", host: "h", port: null },
    ]);
    db.repoConnection.findMany.mockResolvedValue([
      { id: "r1", label: "GH", projectId: "p", provider: "github", apiBaseUrl: null },
    ]);
    db.importSource.findMany.mockResolvedValue([
      { id: "i1", label: "Lin", projectId: "p", source: "linear", baseUrl: null },
      { id: "i2", label: "ADO", projectId: "p", source: "azure-devops", baseUrl: "https://ado" },
    ]);
    db.mCPServer.findMany.mockResolvedValue([
      { id: "m1", label: "Http", projectId: null, url: "https://mcp", command: null },
      { id: "m2", label: "Stdio", projectId: "p", url: null, command: "npx srv" },
    ]);
    const out = await describeForeignOwner({ id: "sec-1", createdById: "u-1" });
    expect(out.bindings.map((b) => [b.type, b.id, b.destination])).toEqual([
      ["db_connector", "d1", "sqlite"],
      ["db_connector", "d2", "mysql://h"],
      ["repo_connector", "r1", "github"],
      ["import_source", "i1", "linear"],
      ["import_source", "i2", "https://ado"],
      ["mcp_server", "m1", "https://mcp"],
      ["mcp_server", "m2", "npx srv"],
    ]);
    expect(out.owner).toEqual({ id: "u-1", username: null, displayName: null });
  });
});

describe("foreignOwnerMessage", () => {
  const base = { secretId: "s", bindings: [] };

  it("names the owner by display name, then username, then id", () => {
    expect(
      foreignOwnerMessage({ ...base, owner: { id: "u", username: "cora", displayName: "Cora" } }),
    ).toContain("belongs to Cora.");
    expect(
      foreignOwnerMessage({ ...base, owner: { id: "u", username: "cora", displayName: null } }),
    ).toContain("belongs to cora.");
    expect(
      foreignOwnerMessage({ ...base, owner: { id: "u-9", username: null, displayName: null } }),
    ).toContain("belongs to user u-9.");
  });

  it("lists each binding with its destination when it has one", () => {
    const msg = foreignOwnerMessage({
      secretId: "s",
      owner: { id: "u", username: null, displayName: "Cora" },
      bindings: [
        { type: "db_connector", id: "d", label: "DB", projectId: "p", destination: "pg://h" },
        { type: "mcp_server", id: "m", label: "MCP", projectId: null, destination: null },
      ],
    });
    expect(msg).toContain("bound to DB (pg://h), MCP.");
    expect(msg).toContain("confirmForeignOwner");
  });
});
