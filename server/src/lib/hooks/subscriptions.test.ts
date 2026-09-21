/**
 * #675 (epic #671) — HookSubscription service authz + SSRF hardening.
 *
 * Covers the object-level project scoping on by-id mutations (BOLA / OWASP A01)
 * and the outbound-webhook egress guard on create/update (SSRF / OWASP A10).
 * Prisma + audit are mocked so no DB is touched; the DNS resolver is injected so
 * the private/public decision is deterministic (no real network).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const findFirst = vi.fn();
const update = vi.fn();
const deleteMany = vi.fn();
const findMany = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    hookSubscription: { create, findFirst, update, deleteMany, findMany },
  },
}));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));

const {
  createSubscription,
  updateSubscription,
  deleteSubscription,
  listSubscriptions,
  listEnabledFor,
  runWebhook,
  HookConfigError,
} = await import("./subscriptions.js");
const { AppError } = await import("../../middleware/error-handler.js");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "hook-1",
    projectId: "proj-1",
    event: "sessionEnd",
    handlerKind: "webhook",
    config: JSON.stringify({ url: "https://example.com/hook" }),
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// Resolver that pretends every host is a public IP — lets the happy path run
// without touching DNS.
const publicResolver = async () => ["93.184.216.34"];
// Resolver that pretends every host resolves to an RFC1918 address.
const privateResolver = async () => ["10.0.0.5"];

const EVENT = "sessionEnd";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSubscription — SSRF egress guard", () => {
  it("rejects a webhook targeting a link-local / metadata IP literal", async () => {
    await expect(
      createSubscription({
        projectId: "proj-1",
        event: EVENT as never,
        handlerKind: "webhook",
        config: { url: "http://169.254.169.254/latest/meta-data/" },
      }),
    ).rejects.toBeInstanceOf(HookConfigError);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a webhook targeting a loopback hostname", async () => {
    await expect(
      createSubscription({
        projectId: "proj-1",
        event: EVENT as never,
        handlerKind: "webhook",
        config: { url: "http://localhost:9000/exfil" },
      }),
    ).rejects.toBeInstanceOf(HookConfigError);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a webhook whose hostname resolves to a private address", async () => {
    await expect(
      createSubscription(
        {
          projectId: "proj-1",
          event: EVENT as never,
          handlerKind: "webhook",
          config: { url: "https://internal.attacker.test/hook" },
        },
        "actor-1",
        { resolver: privateResolver },
      ),
    ).rejects.toBeInstanceOf(HookConfigError);
    expect(create).not.toHaveBeenCalled();
  });

  it("allows a webhook whose hostname resolves to a public address", async () => {
    create.mockResolvedValueOnce(row());
    const dto = await createSubscription(
      {
        projectId: "proj-1",
        event: EVENT as never,
        handlerKind: "webhook",
        config: { url: "https://example.com/hook" },
      },
      "actor-1",
      { resolver: publicResolver },
    );
    expect(dto.projectId).toBe("proj-1");
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not run the egress guard for non-webhook handlers", async () => {
    create.mockResolvedValueOnce(row({ handlerKind: "builtin", config: "{}" }));
    const dto = await createSubscription({
      projectId: "proj-1",
      event: EVENT as never,
      handlerKind: "builtin",
      config: {},
    });
    expect(dto.handlerKind).toBe("builtin");
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("updateSubscription — project scoping (BOLA)", () => {
  it("404s (AppError) when the hook id is not in the caller's project", async () => {
    findFirst.mockResolvedValueOnce(null);
    await expect(
      updateSubscription("proj-1", "hook-other", { enabled: false }, "actor-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
    // Scoped lookup must include BOTH id and projectId.
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "hook-other", projectId: "proj-1" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("updates when the hook belongs to the project", async () => {
    findFirst.mockResolvedValueOnce(row());
    update.mockResolvedValueOnce(row({ enabled: false }));
    const dto = await updateSubscription("proj-1", "hook-1", { enabled: false }, "actor-1");
    expect(dto.enabled).toBe(false);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "hook-1" } }));
  });

  it("re-runs the SSRF guard when the config url changes", async () => {
    findFirst.mockResolvedValueOnce(row());
    await expect(
      updateSubscription(
        "proj-1",
        "hook-1",
        { config: { url: "http://127.0.0.1/exfil" } },
        "actor-1",
      ),
    ).rejects.toBeInstanceOf(HookConfigError);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("deleteSubscription — project scoping (BOLA)", () => {
  it("404s when the hook id is not in the caller's project (0 rows)", async () => {
    deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(deleteSubscription("proj-1", "hook-other", "actor-1")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "hook-other", projectId: "proj-1" } });
  });

  it("deletes when the hook belongs to the project", async () => {
    deleteMany.mockResolvedValueOnce({ count: 1 });
    await expect(deleteSubscription("proj-1", "hook-1", "actor-1")).resolves.toBeUndefined();
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "hook-1", projectId: "proj-1" } });
  });

  it("throws an AppError (not a generic Error) on the not-found path", async () => {
    deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(deleteSubscription("proj-1", "hook-x")).rejects.toBeInstanceOf(AppError);
  });
});

describe("read helpers", () => {
  it("listSubscriptions scopes findMany to the project and maps rows to DTOs", async () => {
    findMany.mockResolvedValueOnce([row(), row({ id: "hook-2", config: "not json" })]);
    const dtos = await listSubscriptions("proj-1");
    expect(findMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1" },
      orderBy: { createdAt: "asc" },
    });
    expect(dtos).toHaveLength(2);
    // Malformed config JSON falls back to an empty object rather than throwing.
    expect(dtos[1].config).toEqual({});
  });

  it("listEnabledFor filters by project, event and enabled=true", async () => {
    findMany.mockResolvedValueOnce([row()]);
    const dtos = await listEnabledFor("proj-1", "sessionEnd" as never);
    expect(findMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", event: "sessionEnd", enabled: true },
      orderBy: { createdAt: "asc" },
    });
    expect(dtos).toHaveLength(1);
  });
});

describe("runWebhook — best-effort dispatch", () => {
  // A public resolver keeps the send-time SSRF guard hermetic (no real DNS).
  const pub = { resolver: publicResolver };

  it("returns true on a 2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const okResult = await runWebhook(
      "https://example.com/h",
      { a: 1 },
      {},
      fetchImpl as never,
      pub,
    );
    expect(okResult).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns false on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    expect(await runWebhook("https://example.com/h", {}, {}, fetchImpl as never, pub)).toBe(false);
  });

  it("returns false (never throws) when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await runWebhook("https://example.com/h", {}, {}, fetchImpl as never, pub)).toBe(false);
  });

  // --- Send-time SSRF (#675): config-time validation is not enough. ---

  it("does NOT dispatch when the host resolves to a metadata/private IP at send time (DNS rebinding)", async () => {
    // Models a TOCTOU rebind: the URL was public when the hook was created, but
    // the host now resolves to the cloud-metadata address. The send-time guard
    // must reject BEFORE any socket is opened.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const rebindResolver = async () => ["169.254.169.254"];
    const result = await runWebhook(
      "https://rebind.attacker.test/hook",
      { secret: "exfil" },
      {},
      fetchImpl as never,
      { resolver: rebindResolver },
    );
    expect(result).toBe(false);
    // The attacker endpoint was never contacted — no exfil, no metadata read.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does NOT follow a redirect — passes redirect:'error' so a 302 to metadata is blocked", async () => {
    // A real undici fetch with redirect:"error" throws on any 30x; emulate that
    // and assert the guard opts out of redirect-following at send time.
    let capturedInit: (RequestInit & { redirect?: string }) | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit & { redirect?: string }) => {
      capturedInit = init;
      if (init.redirect === "error") throw new TypeError("unexpected redirect");
      return new Response(null, { status: 200 });
    });
    const result = await runWebhook("https://good.attacker.test/hook", {}, {}, fetchImpl as never, {
      resolver: publicResolver,
    });
    // The 302 → http://169.254.169.254/ is refused, not followed.
    expect(result).toBe(false);
    expect(capturedInit?.redirect).toBe("error");
  });
});
