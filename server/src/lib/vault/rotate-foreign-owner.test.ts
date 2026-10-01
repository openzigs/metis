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
  testManagementConnection: { findMany: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
// #557 — a pass-through spy, so a test can count the HKDF derivations.
const hkdf = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    hkdfSync: (...args: Parameters<typeof real.hkdfSync>) => {
      hkdf.calls += 1;
      return real.hkdfSync(...args);
    },
  };
});

const {
  bindingsChangedMessage,
  bindingsDiffer,
  canonicalBindings,
  describeForeignOwner,
  foreignOwnerMessage,
  routingDigest,
  routingFields,
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
    db.testManagementConnection,
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
    // #609 — candidates only: any live connection holding a vault ref at all.
    expect(db.testManagementConnection.findMany.mock.calls[0]![0].where).toEqual({
      deletedAt: null,
      OR: [
        { authConfigJson: { contains: "${vault:" } },
        { tlsConfigJson: { contains: "${vault:" } },
      ],
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

function tm(over: Record<string, unknown>) {
  return {
    projectId: "p",
    kind: "zephyr",
    baseUrl: "https://tm.example",
    authConfigJson: "{}",
    proxyConfigJson: null,
    tlsConfigJson: null,
    ...over,
  };
}

describe("#609 — describeForeignOwner lists test-management connections", () => {
  it("keeps connections whose auth or TLS config reaches the secret by id or label, and drops the rest", async () => {
    db.testManagementConnection.findMany.mockResolvedValue([
      tm({
        id: "zBearer",
        label: "Z",
        authConfigJson: JSON.stringify({ bearerTokenRef: "${vault:sec-1}" }),
      }),
      tm({
        id: "xClient",
        label: "X",
        kind: "xray",
        baseUrl: "https://xray.example",
        authConfigJson: JSON.stringify({
          clientIdRef: "${vault:other}",
          clientSecretRef: "${vault:global:gh-token}",
        }),
      }),
      tm({
        id: "tCa",
        label: "T",
        kind: "testrail",
        authConfigJson: JSON.stringify({ email: "a@b", apiKeyRef: "${vault:other}" }),
        tlsConfigJson: JSON.stringify({ rejectUnauthorized: true, caCertRef: "${vault:gh-token}" }),
      }),
      tm({
        id: "other",
        label: "O",
        authConfigJson: JSON.stringify({ bearerTokenRef: "${vault:other}" }),
      }),
      tm({
        id: "wrongScope",
        label: "W",
        authConfigJson: JSON.stringify({ bearerTokenRef: "${vault:project:gh-token}" }),
      }),
      tm({ id: "badJson", label: "B", authConfigJson: "{not json ${vault:sec-1}" }),
      tm({ id: "nullTls", label: "N", tlsConfigJson: "null" }),
    ]);
    const out = await describeForeignOwner(SECRET);
    expect(out.bindings.map((b) => [b.type, b.id, b.label, b.projectId, b.destination])).toEqual([
      ["test_management_connection", "zBearer", "Z", "p", "https://tm.example"],
      ["test_management_connection", "xClient", "X", "p", "https://xray.example"],
      ["test_management_connection", "tCa", "T", "p", "https://tm.example"],
    ]);
    for (const b of out.bindings) expect(b.routing).toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows the same baseUrl but a different routing when only the proxy or TLS config changes", async () => {
    const auth = JSON.stringify({ bearerTokenRef: "${vault:sec-1}" });
    const row = tm({ id: "z", label: "Z", authConfigJson: auth });
    db.testManagementConnection.findMany.mockResolvedValueOnce([row]);
    const before = (await describeForeignOwner(SECRET)).bindings[0]!;
    for (const change of [
      { proxyConfigJson: JSON.stringify({ url: "http://evil-proxy:8080" }) },
      {
        tlsConfigJson: JSON.stringify({ rejectUnauthorized: true, caCertRef: "${vault:owner-ca}" }),
      },
      { kind: "xray" },
    ]) {
      db.testManagementConnection.findMany.mockResolvedValueOnce([{ ...row, ...change }]);
      const after = (await describeForeignOwner(SECRET)).bindings[0]!;
      expect(after.destination).toBe(before.destination);
      expect(after.routing, JSON.stringify(change)).not.toBe(before.routing);
      expect(
        bindingsDiffer({ secretId: "s", owner: SECRET_OWNER, bindings: [after] }, [before]),
      ).toBe(true);
    }
  });

  it("an empty-binding message no longer claims test-management auth went unchecked", () => {
    expect(UNBOUND_NOTE).toContain("test-management connection");
    expect(UNBOUND_NOTE).not.toContain("test-management auth");
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
    expect(msg).toContain("confirmedBindings");
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
    routing: `r-${id}`,
  });
  const details = (...ids: string[]) => ({
    secretId: "s",
    owner: { id: "u", username: "cora", displayName: null },
    bindings: ids.map(binding),
  });

  // What the 409 showed: type, id and destination of each binding.
  const shown = (...ids: string[]) =>
    ids.map((id) => ({
      type: "db_connector" as const,
      id,
      destination: `pg://${id}`,
      routing: `r-${id}`,
    }));

  it("is false only for the same set of bindings, in any order and with duplicates", () => {
    expect(bindingsDiffer(details(), [])).toBe(false);
    expect(bindingsDiffer(details("a", "b"), shown("b", "a"))).toBe(false);
    expect(bindingsDiffer(details("a", "b"), shown("a", "b", "a"))).toBe(false);
  });

  it("is true when a binding was added, removed or swapped", () => {
    expect(bindingsDiffer(details("a", "b"), shown("a"))).toBe(true);
    expect(bindingsDiffer(details("a"), shown("a", "b"))).toBe(true);
    expect(bindingsDiffer(details("a", "c"), shown("a", "b"))).toBe(true);
    expect(bindingsDiffer(details("a"), [])).toBe(true);
    expect(bindingsDiffer(details(), shown("a"))).toBe(true);
  });

  it("is true when a binding keeps its id but was re-pointed (PR #544 review)", () => {
    const [a] = shown("a");
    expect(bindingsDiffer(details("a"), [{ ...a!, destination: "pg://evil" }])).toBe(true);
    expect(bindingsDiffer(details("a"), [{ ...a!, destination: null }])).toBe(true);
    expect(bindingsDiffer(details("a"), [{ ...a!, type: "mcp_server" }])).toBe(true);
  });

  it("#557: is true when only the routing digest differs, under the same destination", () => {
    const [a] = shown("a");
    expect(bindingsDiffer(details("a"), [{ ...a!, routing: "r-other" }])).toBe(true);
  });

  it("canonicalBindings dedupes, orders and drops anything but type, id, destination, routing", () => {
    const extra = {
      type: "db_connector" as const,
      id: "a",
      destination: "pg://a",
      routing: "r-a",
      label: "x",
    };
    expect(canonicalBindings([...shown("b"), extra, ...shown("a")])).toEqual(shown("a", "b"));
  });

  it("says the bindings changed and lists the live ones", () => {
    const msg = bindingsChangedMessage(details("a", "b"));
    expect(msg).toContain("owned by cora");
    expect(msg).toContain("changed since you confirmed");
    expect(msg).toContain("bound to A (pg://a), B (pg://b).");
    expect(msg).toContain("confirmedBindings");
    expect(bindingsChangedMessage(details())).toContain(UNBOUND_NOTE);
  });
});

describe("#557 — routing digest over the full routing fields", () => {
  const stdio = {
    transport: "stdio",
    runtime: "native",
    command: "npx srv",
    args: JSON.stringify(["--port", "1"]),
    url: null,
    headers: null,
    envJson: null,
    envSecretId: "sec-1",
    egressAllowlist: null,
  };
  const pg = {
    driver: "postgres",
    host: "h",
    port: 5432,
    databaseName: "app",
    options: null,
  };

  it("describeForeignOwner shows the same destination but a different routing for new MCP args", async () => {
    db.mCPServer.findMany.mockResolvedValueOnce([
      { id: "m", label: "M", projectId: "p", ...stdio },
    ]);
    const before = (await describeForeignOwner(SECRET)).bindings[0]!;
    db.mCPServer.findMany.mockResolvedValueOnce([
      { id: "m", label: "M", projectId: "p", ...stdio, args: JSON.stringify(["--to", "evil"]) },
    ]);
    const after = (await describeForeignOwner(SECRET)).bindings[0]!;
    expect(after.destination).toBe(before.destination);
    expect(after.routing).not.toBe(before.routing);
    expect(
      bindingsDiffer({ ...{ secretId: "s", owner: SECRET_OWNER }, bindings: [after] }, [before]),
    ).toBe(true);
  });

  it("describeForeignOwner shows the same destination but a different routing for a new database", async () => {
    db.databaseConnection.findMany.mockResolvedValueOnce([
      { id: "d", label: "D", projectId: "p", ...pg },
    ]);
    const before = (await describeForeignOwner(SECRET)).bindings[0]!;
    db.databaseConnection.findMany.mockResolvedValueOnce([
      { id: "d", label: "D", projectId: "p", ...pg, databaseName: "other" },
    ]);
    const after = (await describeForeignOwner(SECRET)).bindings[0]!;
    expect(after.destination).toBe("postgres://h:5432");
    expect(after.destination).toBe(before.destination);
    expect(after.routing).not.toBe(before.routing);
  });

  it("covers every routing field of every kind, and is stable for the same row", () => {
    const cases: Array<[Parameters<typeof routingDigest>[0], Record<string, unknown>]> = [
      ["db_connector", pg],
      ["repo_connector", { provider: "github", apiBaseUrl: "https://ghe" }],
      [
        "import_source",
        { source: "jira", baseUrl: "https://j", jiraConnectionId: "jc", filter: "{}" },
      ],
      ["mcp_server", stdio],
      [
        "jira_connection",
        { baseUrl: "https://j", proxyUrl: null, tlsRejectUnauthorized: true, tlsCaSecretId: null },
      ],
      [
        "test_management_connection",
        {
          kind: "zephyr",
          baseUrl: "https://tm",
          proxyConfigJson: JSON.stringify({ url: "http://p" }),
          tlsConfigJson: JSON.stringify({ rejectUnauthorized: true, caCertRef: null }),
        },
      ],
    ];
    for (const [type, row] of cases) {
      const fields = routingFields[type] as (r: Record<string, unknown>) => unknown[];
      const base = routingDigest(type, "x", fields(row));
      expect(routingDigest(type, "x", fields({ ...row }))).toBe(base);
      expect(base).toMatch(/^[0-9a-f]{64}$/);
      for (const key of Object.keys(row)) {
        const changed = { ...row, [key]: row[key] === true ? false : `${String(row[key])}-x` };
        expect(routingDigest(type, "x", fields(changed)), `${type}.${key}`).not.toBe(base);
      }
    }
  });

  it("derives the HKDF key once per listing, not once per binding", async () => {
    db.databaseConnection.findMany.mockResolvedValueOnce([
      { id: "d1", label: "D1", projectId: "p", ...pg },
      { id: "d2", label: "D2", projectId: "p", ...pg },
    ]);
    db.mCPServer.findMany.mockResolvedValueOnce([
      { id: "m", label: "M", projectId: "p", ...stdio },
    ]);
    db.jiraConnection.findMany.mockResolvedValueOnce([
      {
        id: "j",
        label: "J",
        projectId: "p",
        baseUrl: "https://j",
        proxyUrl: null,
        tlsRejectUnauthorized: true,
        tlsCaSecretId: null,
      },
    ]);
    db.testManagementConnection.findMany.mockResolvedValueOnce([
      tm({
        id: "t",
        label: "T",
        authConfigJson: JSON.stringify({ bearerTokenRef: "${vault:sec-1}" }),
      }),
    ]);
    hkdf.calls = 0;
    const { bindings } = await describeForeignOwner(SECRET);
    expect(bindings).toHaveLength(5);
    expect(hkdf.calls).toBe(1);
    // …and the shared key gives the same digest a standalone call derives.
    expect(bindings[0]!.routing).toBe(
      routingDigest("db_connector", "d1", routingFields.db_connector(pg)),
    );
  });

  it("ignores the DB allow-list, which never chooses the destination", () => {
    const f = routingFields.db_connector;
    expect(routingDigest("db_connector", "d", f({ ...pg, options: '{"allowList":["t"]}' }))).toBe(
      routingDigest("db_connector", "d", f(pg)),
    );
  });

  it("is keyed: not a plain hash of the fields, and changes with the server secret", async () => {
    const { createHash } = await import("node:crypto");
    const fields = routingFields.mcp_server(stdio);
    const digest = routingDigest("mcp_server", "m", fields);
    expect(digest).not.toBe(
      createHash("sha256")
        .update(JSON.stringify(["mcp_server", "m", ...fields]))
        .digest("hex"),
    );
    const prev = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "a-different-test-signing-secret-of-enough-length-557";
    try {
      expect(routingDigest("mcp_server", "m", fields)).not.toBe(digest);
    } finally {
      if (prev === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prev;
    }
  });
});

const SECRET_OWNER = { id: "u-1", username: null, displayName: null };
