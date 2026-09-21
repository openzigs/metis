/**
 * Tests for the test-management connection service (Epic #856 / Issue #871).
 *
 * Covers:
 *  - CRUD across the three supported kinds (xray / zephyr / testrail).
 *  - Vault round-trip — raw secrets are persisted to the vault and replaced
 *    with `${vault:...}` refs in `authConfigJson` / `tlsConfigJson`.
 *  - SSRF allow-list is enforced on create, update (when baseUrl changes) and
 *    every connectivity test.
 *  - Label uniqueness within a project.
 *  - Soft-delete semantics.
 *  - Connectivity test wiring for each kind.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestManagementConnection,
  deleteTestManagementConnection,
  getTestManagementConnection,
  listTestManagementConnections,
  loadResolvedTestManagementConnection,
  testTestManagementConnection,
  updateTestManagementConnection,
} from "../../../../src/lib/connectors/testmgmt/connection-service.js";
import { ConnectorError } from "../../../../src/lib/connectors/types.js";

// ---- Mock audit (top-level module mock) ------------------------------------

vi.mock("../../../../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
  getAuditService: () => ({ record: vi.fn() }),
}));

// ---- In-memory prisma stub -------------------------------------------------

interface Row {
  id: string;
  projectId: string;
  label: string;
  kind: string;
  baseUrl: string;
  authConfigJson: string;
  proxyConfigJson: string | null;
  tlsConfigJson: string | null;
  status: string;
  errorMessage: string | null;
  lastTestedAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function makeDb() {
  const rows = new Map<string, Row>();
  let counter = 0;
  return {
    rows,
    db: {
      testManagementConnection: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          for (const r of rows.values()) {
            if (where.deletedAt === null && r.deletedAt !== null) continue;
            let match = true;
            for (const [k, v] of Object.entries(where)) {
              if (k === "deletedAt" || k === "NOT") continue;
              if ((r as unknown as Record<string, unknown>)[k] !== v) match = false;
            }
            if (where.NOT && typeof where.NOT === "object") {
              const notObj = where.NOT as Record<string, unknown>;
              for (const [k, v] of Object.entries(notObj)) {
                if ((r as unknown as Record<string, unknown>)[k] === v) match = false;
              }
            }
            if (match) return r;
          }
          return null;
        }),
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return [...rows.values()].filter(
            (r) => r.projectId === where.projectId && r.deletedAt === null,
          );
        }),
        create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
          counter += 1;
          const row: Row = {
            id: `tmc_${counter}`,
            projectId: "",
            label: "",
            kind: "",
            baseUrl: "",
            authConfigJson: "{}",
            proxyConfigJson: null,
            tlsConfigJson: null,
            status: "untested",
            errorMessage: null,
            lastTestedAt: null,
            createdById: "",
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            ...(data as Row),
          };
          rows.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const r = rows.get(where.id);
          if (!r) throw new Error("not found");
          const next = { ...r, ...data, updatedAt: new Date() } as Row;
          rows.set(where.id, next);
          return next;
        }),
      },
    },
  };
}

// ---- Vault stub ------------------------------------------------------------

function makeVault() {
  const secrets = new Map<string, { id: string; label: string; plaintext: string }>();
  let counter = 0;
  const vault = {
    create: vi.fn(async (label: string, value: string) => {
      counter += 1;
      const rec = { id: `secret_${counter}`, label, plaintext: value };
      secrets.set(rec.id, rec);
      return { id: rec.id, label };
    }),
    read: vi.fn(async (id: string) => {
      const rec = secrets.get(id);
      if (!rec) throw new Error(`unknown secret ${id}`);
      return { plaintext: rec.plaintext };
    }),
    list: vi.fn(async () => [...secrets.values()].map((s) => ({ id: s.id, label: s.label }))),
  };
  // Cast through unknown — we only need the four methods the service touches.
  return {
    vault: vault as unknown as import("../../../../src/lib/vault/vault-service.js").VaultService,
    secrets,
  };
}

// ---- Test fixtures ---------------------------------------------------------

function depsFor(opts?: {
  assertHost?: ReturnType<typeof vi.fn>;
  fetchFn?: ReturnType<typeof vi.fn>;
}) {
  const { db, rows } = makeDb();
  const { vault, secrets } = makeVault();
  const assertHost = opts?.assertHost ?? vi.fn(async () => undefined);
  const fetchFn =
    opts?.fetchFn ??
    vi.fn(async () => ({ ok: true, status: 200, text: async () => '"jwt.value"' }));
  return {
    deps: { prisma: db, vault, assertHost, fetchFn },
    db,
    rows,
    vault,
    secrets,
    assertHost,
    fetchFn,
  };
}

const ACTOR = "user_abc";
const PROJECT = "proj_1";

const XRAY_BASE = "https://xray.cloud.getxray.app";
const ZEPHYR_BASE = "https://api.zephyrscale.smartbear.com";
const TR_BASE = "https://example.testrail.io";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("createTestManagementConnection", () => {
  it("creates an xray connection and stores secrets in the vault, not on the row", async () => {
    const { deps, rows, vault, assertHost } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "xray-primary",
        kind: "xray",
        baseUrl: XRAY_BASE,
        auth: { kind: "xray", clientId: "cid-raw", clientSecret: "csecret-raw" },
        proxyConfig: null,
        tlsConfig: null,
      },
      ACTOR,
      deps,
    );

    expect(created.kind).toBe("xray");
    expect(created.status).toBe("untested");
    expect(assertHost).toHaveBeenCalledWith("xray.cloud.getxray.app", "xray");

    const row = [...rows.values()][0]!;
    // Plaintext must NEVER be in authConfigJson — only vault refs.
    expect(row.authConfigJson).not.toContain("cid-raw");
    expect(row.authConfigJson).not.toContain("csecret-raw");
    expect(row.authConfigJson).toMatch(/\$\{vault:secret_\d+\}/);
    const refs = JSON.parse(row.authConfigJson) as Record<string, string>;
    expect(refs.clientIdRef).toMatch(/^\$\{vault:secret_\d+\}$/);
    expect(refs.clientSecretRef).toMatch(/^\$\{vault:secret_\d+\}$/);
    expect(refs.clientIdRef).not.toBe(refs.clientSecretRef);

    // And the vault really has the plaintext.
    expect(vault.create).toHaveBeenCalledTimes(2);
  });

  it("creates a zephyr connection (single bearer ref)", async () => {
    const { deps, rows } = depsFor();
    await createTestManagementConnection(
      PROJECT,
      {
        label: "zephyr",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "bear-raw" },
      },
      ACTOR,
      deps,
    );
    const row = [...rows.values()][0]!;
    expect(row.authConfigJson).not.toContain("bear-raw");
    const refs = JSON.parse(row.authConfigJson) as Record<string, string>;
    expect(refs.kind).toBe("zephyr");
    expect(refs.bearerTokenRef).toMatch(/^\$\{vault:secret_\d+\}$/);
  });

  it("creates a testrail connection — email is plaintext (not secret), api key goes to vault", async () => {
    const { deps, rows } = depsFor();
    await createTestManagementConnection(
      PROJECT,
      {
        label: "testrail",
        kind: "testrail",
        baseUrl: TR_BASE,
        auth: { kind: "testrail", email: "qa@example.com", apiKey: "apikey-raw" },
      },
      ACTOR,
      deps,
    );
    const row = [...rows.values()][0]!;
    expect(row.authConfigJson).toContain("qa@example.com");
    expect(row.authConfigJson).not.toContain("apikey-raw");
    const refs = JSON.parse(row.authConfigJson) as Record<string, string>;
    expect(refs.email).toBe("qa@example.com");
    expect(refs.apiKeyRef).toMatch(/^\$\{vault:secret_\d+\}$/);
  });

  it("persists a TLS CA cert in the vault and only stores the ref + rejectUnauthorized flag", async () => {
    const { deps, rows, vault } = depsFor();
    await createTestManagementConnection(
      PROJECT,
      {
        label: "with-ca",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "tok" },
        tlsConfig: { rejectUnauthorized: false, caCert: "-----BEGIN CERT-----\n..." },
      },
      ACTOR,
      deps,
    );
    const row = [...rows.values()][0]!;
    expect(row.tlsConfigJson).not.toBeNull();
    const tls = JSON.parse(row.tlsConfigJson!) as Record<string, unknown>;
    expect(tls.rejectUnauthorized).toBe(false);
    expect(tls.caCertRef).toMatch(/^\$\{vault:secret_\d+\}$/);
    expect(vault.create).toHaveBeenCalledTimes(2); // bearer + CA
  });

  it("rejects baseUrls whose host fails the SSRF allow-list", async () => {
    const assertHost = vi.fn(async (host: string) => {
      if (host === "internal.local") {
        throw new ConnectorError(403, "HOST_NOT_ALLOWED", "blocked");
      }
    });
    const { deps } = depsFor({ assertHost });
    await expect(
      createTestManagementConnection(
        PROJECT,
        {
          label: "evil",
          kind: "xray",
          baseUrl: "https://internal.local",
          auth: { kind: "xray", clientId: "a", clientSecret: "b" },
        },
        ACTOR,
        deps,
      ),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
  });

  it("rejects when auth.kind disagrees with connection kind", async () => {
    const { deps } = depsFor();
    await expect(
      createTestManagementConnection(
        PROJECT,
        {
          label: "mismatch",
          kind: "xray",
          baseUrl: XRAY_BASE,
          auth: { kind: "zephyr", bearerToken: "x" },
        } as never,
        ACTOR,
        deps,
      ),
    ).rejects.toMatchObject({ code: "TESTMGMT_KIND_MISMATCH" });
  });

  it("enforces label uniqueness within a project", async () => {
    const { deps } = depsFor();
    await createTestManagementConnection(
      PROJECT,
      {
        label: "dup",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    await expect(
      createTestManagementConnection(
        PROJECT,
        {
          label: "dup",
          kind: "zephyr",
          baseUrl: ZEPHYR_BASE,
          auth: { kind: "zephyr", bearerToken: "t2" },
        },
        ACTOR,
        deps,
      ),
    ).rejects.toMatchObject({ code: "TESTMGMT_LABEL_TAKEN" });
  });

  it("passes proxy config through verbatim (it contains no secret material)", async () => {
    const { deps, rows } = depsFor();
    await createTestManagementConnection(
      PROJECT,
      {
        label: "with-proxy",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
        proxyConfig: { url: "http://corp.proxy:3128" },
      },
      ACTOR,
      deps,
    );
    const row = [...rows.values()][0]!;
    expect(JSON.parse(row.proxyConfigJson!)).toEqual({ url: "http://corp.proxy:3128" });
  });
});

// ---------------------------------------------------------------------------

describe("listTestManagementConnections / getTestManagementConnection", () => {
  it("returns rows for a project and masks secrets in the API view", async () => {
    const { deps } = depsFor();
    await createTestManagementConnection(
      PROJECT,
      {
        label: "a",
        kind: "testrail",
        baseUrl: TR_BASE,
        auth: { kind: "testrail", email: "qa@example.com", apiKey: "apikey-raw" },
      },
      ACTOR,
      deps,
    );
    const list = await listTestManagementConnections(PROJECT, deps);
    expect(list).toHaveLength(1);
    const detail = list[0]!;
    expect(detail.authConfig.email).toBe("qa@example.com");
    expect(detail.authConfig.apiKeyRef).toMatch(/^\$\{vault:secret_\d+\}$/);
    // No plaintext key escapes via the API view.
    expect(JSON.stringify(detail)).not.toContain("apikey-raw");

    const fetched = await getTestManagementConnection(detail.id, undefined, deps);
    expect(fetched.id).toBe(detail.id);
  });

  it("findOrThrow throws 404 for missing or wrong-project rows", async () => {
    const { deps } = depsFor();
    await expect(getTestManagementConnection("missing", undefined, deps)).rejects.toMatchObject({
      code: "TESTMGMT_NOT_FOUND",
    });
  });
});

// ---------------------------------------------------------------------------

describe("updateTestManagementConnection", () => {
  it("re-asserts the SSRF allow-list when baseUrl changes and resets status", async () => {
    const assertHost = vi.fn(async (host: string) => {
      if (host === "blocked.example.com") {
        throw new ConnectorError(403, "HOST_NOT_ALLOWED", "blocked");
      }
    });
    const { deps, rows } = depsFor({ assertHost });
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "z",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    // Pretend the connection had already been tested ok.
    rows.get(created.id)!.status = "ok";

    await expect(
      updateTestManagementConnection(
        created.id,
        { baseUrl: "https://blocked.example.com" },
        ACTOR,
        undefined,
        deps,
      ),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });

    // Allowed baseUrl change resets status.
    const updated = await updateTestManagementConnection(
      created.id,
      { baseUrl: "https://api.zephyrscale.smartbear.com/v2" },
      ACTOR,
      undefined,
      deps,
    );
    expect(updated.status).toBe("untested");
  });

  it("rotates auth credentials by writing new vault entries", async () => {
    const { deps, vault, rows } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "rotate",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "old" },
      },
      ACTOR,
      deps,
    );
    const beforeWrites = vault.create.mock.calls.length;
    await updateTestManagementConnection(
      created.id,
      { auth: { kind: "zephyr", bearerToken: "rotated" } },
      ACTOR,
      undefined,
      deps,
    );
    expect(vault.create.mock.calls.length).toBeGreaterThan(beforeWrites);
    const row = rows.get(created.id)!;
    expect(row.authConfigJson).not.toContain("rotated");
    expect(row.status).toBe("untested");
  });

  it("rejects auth-kind changes (immutable kind)", async () => {
    const { deps } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "fix-kind",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    await expect(
      updateTestManagementConnection(
        created.id,
        { auth: { kind: "testrail", email: "x@x.com", apiKey: "k" } },
        ACTOR,
        undefined,
        deps,
      ),
    ).rejects.toMatchObject({ code: "TESTMGMT_KIND_MISMATCH" });
  });

  it("rejects duplicate labels on rename", async () => {
    const { deps } = depsFor();
    await createTestManagementConnection(
      PROJECT,
      {
        label: "a",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    const second = await createTestManagementConnection(
      PROJECT,
      {
        label: "b",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    await expect(
      updateTestManagementConnection(second.id, { label: "a" }, ACTOR, undefined, deps),
    ).rejects.toMatchObject({ code: "TESTMGMT_LABEL_TAKEN" });
  });

  it("clears tlsConfig when null is passed", async () => {
    const { deps, rows } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "tls",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
        tlsConfig: { rejectUnauthorized: false, caCert: null },
      },
      ACTOR,
      deps,
    );
    expect(rows.get(created.id)!.tlsConfigJson).not.toBeNull();
    await updateTestManagementConnection(created.id, { tlsConfig: null }, ACTOR, undefined, deps);
    expect(rows.get(created.id)!.tlsConfigJson).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("deleteTestManagementConnection", () => {
  it("soft-deletes the row (sets deletedAt) so future reads return 404", async () => {
    const { deps, rows } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "del",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    await deleteTestManagementConnection(created.id, ACTOR, undefined, deps);
    expect(rows.get(created.id)!.deletedAt).not.toBeNull();
    await expect(getTestManagementConnection(created.id, undefined, deps)).rejects.toMatchObject({
      code: "TESTMGMT_NOT_FOUND",
    });
    const list = await listTestManagementConnections(PROJECT, deps);
    expect(list).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("testTestManagementConnection", () => {
  it("performs the Xray JWT exchange and records ok status", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '"xray.jwt.token"',
    }));
    const { deps, rows } = depsFor({ fetchFn });
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "x",
        kind: "xray",
        baseUrl: XRAY_BASE,
        auth: { kind: "xray", clientId: "cid", clientSecret: "csec" },
      },
      ACTOR,
      deps,
    );
    const result = await testTestManagementConnection(created.id, ACTOR, undefined, deps);
    expect(result.ok).toBe(true);
    expect(rows.get(created.id)!.status).toBe("ok");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`${XRAY_BASE}/api/v2/authenticate`);
    expect((init as { method?: string }).method).toBe("POST");
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      client_id: "cid",
      client_secret: "csec",
    });
  });

  it("sends a Bearer header when testing Zephyr", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }));
    const { deps } = depsFor({ fetchFn });
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "z",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "zephyr-jwt" },
      },
      ACTOR,
      deps,
    );
    const result = await testTestManagementConnection(created.id, ACTOR, undefined, deps);
    expect(result.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`${ZEPHYR_BASE}/healthcheck`);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer zephyr-jwt");
  });

  it("sends a Basic header (base64 of email:apiKey) when testing TestRail", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }));
    const { deps } = depsFor({ fetchFn });
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "tr",
        kind: "testrail",
        baseUrl: TR_BASE,
        auth: { kind: "testrail", email: "qa@example.com", apiKey: "the-key" },
      },
      ACTOR,
      deps,
    );
    await testTestManagementConnection(created.id, ACTOR, undefined, deps);
    const headers = (fetchFn.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    const decoded = Buffer.from(headers.Authorization.slice("Basic ".length), "base64").toString(
      "utf8",
    );
    expect(decoded).toBe("qa@example.com:the-key");
  });

  it("re-asserts the SSRF allow-list on every test (defence-in-depth)", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }));
    let allow = true;
    const assertHost = vi.fn(async () => {
      if (!allow) throw new ConnectorError(403, "HOST_NOT_ALLOWED", "blocked");
    });
    const { deps, rows } = depsFor({ fetchFn, assertHost });
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "ssrf",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    // Flip the allow-list off behind the scenes (e.g. operator updated env).
    allow = false;
    await expect(
      testTestManagementConnection(created.id, ACTOR, undefined, deps),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
    // fetch must never have been called once the host was rejected.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(rows.get(created.id)!.status).not.toBe("ok");
  });

  it("records error status when the upstream returns non-2xx", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "down",
    }));
    const { deps, rows } = depsFor({ fetchFn });
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "down",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    const result = await testTestManagementConnection(created.id, ACTOR, undefined, deps);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/HTTP 503/);
    expect(rows.get(created.id)!.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------

describe("loadResolvedTestManagementConnection", () => {
  it("returns plaintext auth values resolved from the vault", async () => {
    const { deps } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "resolve",
        kind: "xray",
        baseUrl: XRAY_BASE,
        auth: { kind: "xray", clientId: "the-id", clientSecret: "the-secret" },
      },
      ACTOR,
      deps,
    );
    const resolved = await loadResolvedTestManagementConnection(created.id, undefined, deps);
    expect(resolved.kind).toBe("xray");
    if (resolved.auth.kind === "xray") {
      expect(resolved.auth.clientId).toBe("the-id");
      expect(resolved.auth.clientSecret).toBe("the-secret");
    } else {
      throw new Error("expected xray auth");
    }
  });

  it("re-asserts SSRF on resolve (callers may use the loaded creds to dial out)", async () => {
    let allow = true;
    const assertHost = vi.fn(async () => {
      if (!allow) throw new ConnectorError(403, "HOST_NOT_ALLOWED", "blocked");
    });
    const { deps } = depsFor({ assertHost });
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "ssrf-resolve",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    allow = false;
    await expect(
      loadResolvedTestManagementConnection(created.id, undefined, deps),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
  });

  it("resolves a TestRail connection with TLS CA cert", async () => {
    const { deps } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "tr-resolve",
        kind: "testrail",
        baseUrl: TR_BASE,
        auth: { kind: "testrail", email: "x@y.com", apiKey: "k" },
        tlsConfig: { rejectUnauthorized: true, caCert: "-----BEGIN CA-----" },
      },
      ACTOR,
      deps,
    );
    const resolved = await loadResolvedTestManagementConnection(created.id, undefined, deps);
    expect(resolved.kind).toBe("testrail");
    if (resolved.auth.kind === "testrail") {
      expect(resolved.auth.apiKey).toBe("k");
      expect(resolved.auth.email).toBe("x@y.com");
    }
    expect(resolved.tls?.caCert).toBe("-----BEGIN CA-----");
    expect(resolved.tls?.rejectUnauthorized).toBe(true);
  });

  it("resolves a Zephyr connection (covers zephyr resolveAuth branch)", async () => {
    const { deps } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "z-resolve",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "the-bearer" },
      },
      ACTOR,
      deps,
    );
    const resolved = await loadResolvedTestManagementConnection(created.id, undefined, deps);
    if (resolved.auth.kind === "zephyr") {
      expect(resolved.auth.bearerToken).toBe("the-bearer");
    } else {
      throw new Error("expected zephyr");
    }
  });
});

// ---------------------------------------------------------------------------

describe("edge cases & error branches", () => {
  it("recovers gracefully when authConfigJson is corrupt — surfaces TESTMGMT_AUTH_MALFORMED", async () => {
    const { deps, rows } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "corrupt",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    // Simulate someone mucking with the row.
    rows.get(created.id)!.authConfigJson = "{not valid json";
    await expect(
      testTestManagementConnection(created.id, ACTOR, undefined, deps),
    ).rejects.toMatchObject({ code: "TESTMGMT_AUTH_MALFORMED" });
  });

  it("rejects stored rows with unknown kind", async () => {
    const { deps, rows } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "weird",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    rows.get(created.id)!.kind = "bogus";
    await expect(
      testTestManagementConnection(created.id, ACTOR, undefined, deps),
    ).rejects.toMatchObject({ code: "TESTMGMT_KIND_INVALID" });
    await expect(
      loadResolvedTestManagementConnection(created.id, undefined, deps),
    ).rejects.toMatchObject({ code: "TESTMGMT_KIND_INVALID" });
  });

  it("records error status when Xray auth returns non-2xx", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "bad creds",
    }));
    const { deps, rows } = depsFor({ fetchFn });
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "x-bad",
        kind: "xray",
        baseUrl: XRAY_BASE,
        auth: { kind: "xray", clientId: "a", clientSecret: "b" },
      },
      ACTOR,
      deps,
    );
    const result = await testTestManagementConnection(created.id, ACTOR, undefined, deps);
    expect(result.ok).toBe(false);
    expect(rows.get(created.id)!.status).toBe("error");
  });

  it("records error status when TestRail returns non-2xx", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    }));
    const { deps, rows } = depsFor({ fetchFn });
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "tr-bad",
        kind: "testrail",
        baseUrl: TR_BASE,
        auth: { kind: "testrail", email: "x@y.com", apiKey: "k" },
      },
      ACTOR,
      deps,
    );
    const result = await testTestManagementConnection(created.id, ACTOR, undefined, deps);
    expect(result.ok).toBe(false);
    expect(rows.get(created.id)!.status).toBe("error");
    expect(result.errorMessage).toMatch(/HTTP 403/);
  });

  it("update can clear proxyConfig and replace it with a different one", async () => {
    const { deps, rows } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "proxy-rotate",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
        proxyConfig: { url: "http://old.proxy:1" },
      },
      ACTOR,
      deps,
    );
    await updateTestManagementConnection(created.id, { proxyConfig: null }, ACTOR, undefined, deps);
    expect(rows.get(created.id)!.proxyConfigJson).toBeNull();
    await updateTestManagementConnection(
      created.id,
      { proxyConfig: { url: "http://new.proxy:2" } },
      ACTOR,
      undefined,
      deps,
    );
    expect(JSON.parse(rows.get(created.id)!.proxyConfigJson!)).toEqual({
      url: "http://new.proxy:2",
    });
  });

  it("update with tlsConfig that has no caCert still persists rejectUnauthorized", async () => {
    const { deps, rows } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "tls-no-ca",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    await updateTestManagementConnection(
      created.id,
      { tlsConfig: { rejectUnauthorized: false } },
      ACTOR,
      undefined,
      deps,
    );
    const tls = JSON.parse(rows.get(created.id)!.tlsConfigJson!) as Record<string, unknown>;
    expect(tls.rejectUnauthorized).toBe(false);
    expect(tls.caCertRef).toBeNull();
  });

  it("scopes findOrThrow to the given projectId", async () => {
    const { deps } = depsFor();
    const created = await createTestManagementConnection(
      PROJECT,
      {
        label: "scoped",
        kind: "zephyr",
        baseUrl: ZEPHYR_BASE,
        auth: { kind: "zephyr", bearerToken: "t" },
      },
      ACTOR,
      deps,
    );
    await expect(
      getTestManagementConnection(created.id, "wrong-project", deps),
    ).rejects.toMatchObject({ code: "TESTMGMT_NOT_FOUND" });
    const ok = await getTestManagementConnection(created.id, PROJECT, deps);
    expect(ok.id).toBe(created.id);
  });
});
