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

const {
  bindingsChangedMessage,
  bindingsDiffer,
  describeForeignOwner,
  foreignOwnerMessage,
  UNBOUND_NOTE,
} = await import("./rotate-foreign-owner.js");

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

const SECRET = { id: "sec-1", name: "global:gh-token", createdById: "u-1" };

describe("describeForeignOwner", () => {
  it("queries every binding column by the secret id, live rows only", async () => {
    await describeForeignOwner(SECRET);
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
      deletedAt: null,
      OR: [
        { envSecretId: "sec-1" },
        { envJson: { contains: "${vault:" } },
        { headers: { contains: "${vault:" } },
      ],
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
      mcp({ id: "m1", label: "Http", projectId: null, url: "https://mcp", envSecretId: "sec-1" }),
      mcp({ id: "m2", label: "Stdio", projectId: "p", command: "npx srv", envSecretId: "sec-1" }),
    ]);
    const out = await describeForeignOwner(SECRET);
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

function mcp(over: Record<string, unknown>) {
  return {
    projectId: "p",
    url: null,
    command: "srv",
    envSecretId: null,
    envJson: null,
    headers: null,
    ...over,
  };
}

describe("describeForeignOwner — MCP env/header ${vault:x} refs", () => {
  it("keeps servers whose env or headers reach the secret by id or label, and drops the rest", async () => {
    db.mCPServer.findMany.mockResolvedValue([
      mcp({ id: "byLabel", label: "L", envJson: JSON.stringify({ T: "${vault:gh-token}" }) }),
      mcp({
        id: "byScoped",
        label: "S",
        envJson: JSON.stringify({ T: "${vault:global:gh-token}" }),
      }),
      mcp({
        id: "byName",
        label: "N",
        envJson: JSON.stringify({ T: "x ${vault:global:gh-token} y" }),
      }),
      mcp({ id: "byId", label: "I", headers: JSON.stringify({ A: "Bearer ${vault:sec-1}" }) }),
      mcp({ id: "other", label: "O", envJson: JSON.stringify({ T: "${vault:other-token}" }) }),
      mcp({
        id: "wrongScope",
        label: "W",
        envJson: JSON.stringify({ T: "${vault:project:gh-token}" }),
      }),
      mcp({ id: "badJson", label: "B", envJson: "{not json ${vault:gh-token}" }),
      mcp({ id: "array", label: "A", envJson: JSON.stringify(["${vault:gh-token}"]) }),
      mcp({ id: "nullJson", label: "Z", headers: "null" }),
    ]);
    const out = await describeForeignOwner(SECRET);
    expect(out.bindings.map((b) => b.id)).toEqual(["byLabel", "byScoped", "byName", "byId"]);
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

  it("with no bindings says only what was checked, never that it is bound nowhere", () => {
    const msg = foreignOwnerMessage({
      ...base,
      owner: { id: "u", username: "c", displayName: null },
    });
    expect(msg).toContain(UNBOUND_NOTE);
    expect(msg).toContain("were not checked");
    expect(msg).not.toContain("not bound");
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
    // #502 — the API text says what a confirm needs and what it does.
    expect(msg).toContain("confirmedBindingIds");
    expect(msg).toContain("becomes yours");
  });
});

describe("#502 — bindingsDiffer / bindingsChangedMessage", () => {
  const binding = (id: string) => ({
    type: "db_connector" as const,
    id,
    label: id.toUpperCase(),
    projectId: "p",
    destination: `pg://${id}`,
  });
  const details = (...ids: string[]) => ({
    secretId: "s",
    owner: { id: "u", username: "cora", displayName: null },
    bindings: ids.map(binding),
  });

  it("is false only for the same set of ids, in any order and with duplicates", () => {
    expect(bindingsDiffer(details(), [])).toBe(false);
    expect(bindingsDiffer(details("a", "b"), ["b", "a"])).toBe(false);
    expect(bindingsDiffer(details("a", "b"), ["a", "b", "a"])).toBe(false);
  });

  it("is true when a binding was added, removed or swapped", () => {
    expect(bindingsDiffer(details("a", "b"), ["a"])).toBe(true);
    expect(bindingsDiffer(details("a"), ["a", "b"])).toBe(true);
    expect(bindingsDiffer(details("a", "c"), ["a", "b"])).toBe(true);
    expect(bindingsDiffer(details("a"), [])).toBe(true);
    expect(bindingsDiffer(details(), ["a"])).toBe(true);
  });

  it("says the bindings changed and lists the live ones", () => {
    const msg = bindingsChangedMessage(details("a", "b"));
    expect(msg).toContain("owned by cora");
    expect(msg).toContain("changed since you confirmed");
    expect(msg).toContain("bound to A (pg://a), B (pg://b).");
    expect(msg).toContain("confirmedBindingIds");
    expect(bindingsChangedMessage(details())).toContain(UNBOUND_NOTE);
  });
});
