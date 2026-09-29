/**
 * #344 — unit tests for the binding rule's pure parts and its ambiguity handling.
 * The route-level proof is `vault-secret-binding-344.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({
  secrets: [] as Array<{ id: string; name: string; createdById: string | null }>,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { secret: { findMany: vi.fn(async () => rows.secrets) } },
}));
const audit = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit }));

const { assertSecretBindingAllowed, refBodyOf, refBodiesIn, SECRET_BINDING_FORBIDDEN } =
  await import("../src/lib/vault/secret-binding.js");
const {
  dbDestinationChanged,
  dbDestinationOptions,
  hasDbDestinationOptions,
  repoDestinationChanged,
} = await import("../src/lib/connectors/destination.js");
const { mcpDestinationChanged, mcpRefs } = await import("../src/lib/mcp/secret-binding.js");

const COORD = { userId: "u-coord", role: "coordinator" as const };
const ctx = { target: { type: "db_connector", id: "c1" } };

describe("#344 secret binding — reference parsing", () => {
  it("reads a whole-value reference body, trimmed; anything else is no reference", () => {
    expect(refBodyOf("${vault: abc }")).toBe("abc");
    expect(refBodyOf("")).toBeNull();
    expect(refBodyOf(null)).toBeNull();
    expect(refBodyOf("plain")).toBeNull();
    expect(refBodyOf("x${vault:abc}")).toBeNull();
    expect(refBodyOf("${vault:   }")).toBeNull();
  });

  it("collects every reference embedded anywhere in a map's string values", () => {
    expect(
      refBodiesIn({ A: "${vault:a}", B: "pre-${vault:b}-${vault:c}", C: "x", D: 3 as never }),
    ).toEqual(["a", "b", "c"]);
    expect(refBodiesIn(null)).toEqual([]);
    expect(mcpRefs({ A: "${vault:a}" }, { Authorization: "Bearer ${vault:h}" })).toEqual([
      "a",
      "h",
    ]);
  });
});

describe("#344 secret binding — assertSecretBindingAllowed", () => {
  beforeEach(() => {
    audit.mockClear();
    rows.secrets = [
      { id: "s-own", name: "global:mine", createdById: "u-coord" },
      { id: "s-foreign", name: "global:theirs", createdById: "u-admin" },
      // Two secrets share the label "shared": the caller owns one, not the other.
      { id: "s-shared-own", name: "global:shared", createdById: "u-coord" },
      { id: "s-shared-foreign", name: "project:shared", createdById: "u-admin" },
    ];
  });

  const refused = (p: Promise<void>) =>
    expect(p).rejects.toMatchObject({ statusCode: 403, code: SECRET_BINDING_FORBIDDEN });

  it("admins (vault.reveal) are never refused", async () => {
    await assertSecretBindingAllowed(
      { userId: "u-admin", role: "admin" },
      { before: [], after: ["s-foreign"], destinationChanged: true },
      ctx,
    );
  });

  it("owned secrets bind by id, label or scoped label", async () => {
    for (const ref of ["s-own", "mine", "global:mine"]) {
      await assertSecretBindingAllowed(
        COORD,
        { before: [], after: [ref], destinationChanged: true },
        ctx,
      );
    }
    expect(audit).not.toHaveBeenCalled();
  });

  it("a label reaching an owned AND a foreign secret is refused — every candidate must be owned", async () => {
    await refused(
      assertSecretBindingAllowed(
        COORD,
        { before: [], after: ["shared"], destinationChanged: true },
        ctx,
      ),
    );
    // Order-independent: the foreign row first gives the same answer.
    rows.secrets.reverse();
    await refused(
      assertSecretBindingAllowed(
        COORD,
        { before: [], after: ["shared"], destinationChanged: true },
        ctx,
      ),
    );
  });

  it("a foreign secret already bound survives an unchanged destination, not a changed one", async () => {
    await assertSecretBindingAllowed(
      COORD,
      { before: ["s-foreign"], after: ["theirs"], destinationChanged: false },
      ctx,
    );
    await refused(
      assertSecretBindingAllowed(
        COORD,
        { before: ["s-foreign"], after: ["s-foreign"], destinationChanged: true },
        ctx,
      ),
    );
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "vault.binding_refused",
        target: ctx.target,
        metadata: expect.objectContaining({ reason: "destination_changed" }),
      }),
    );
  });

  it("unknown references are refused as not owned", async () => {
    await refused(
      assertSecretBindingAllowed(
        COORD,
        { before: [], after: ["nope"], destinationChanged: false },
        ctx,
      ),
    );
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "secret_not_owned" }),
      }),
    );
  });

  it("nothing to bind is always allowed", async () => {
    await assertSecretBindingAllowed(
      COORD,
      { before: ["s-foreign"], after: [], destinationChanged: true },
      ctx,
    );
  });
});

describe("#344 destinations", () => {
  it("DB options: only allowList is not a destination; unparseable options are compared raw", () => {
    expect(
      dbDestinationOptions(JSON.stringify({ allowList: { tables: ["t"] }, host: "h" })),
    ).toEqual({
      host: "h",
    });
    expect(dbDestinationOptions("")).toEqual({});
    expect(dbDestinationOptions(null)).toEqual({});
    expect(dbDestinationOptions("{not json")).toBe("{not json");
    expect(hasDbDestinationOptions({ allowList: {} })).toBe(false);
    expect(hasDbDestinationOptions(undefined)).toBe(false);
    expect(hasDbDestinationOptions({ tnsAlias: "x" })).toBe(true);
    expect(hasDbDestinationOptions("{not json")).toBe(true);
    expect(hasDbDestinationOptions("[1]")).toBe(true);
  });

  it("DB: compares only the fields a patch names, normalising blank host and zero port", () => {
    const existing = { driver: "postgres", host: "Db.Example", port: null, options: null };
    expect(dbDestinationChanged(existing, {})).toBe(false);
    expect(
      dbDestinationChanged(existing, { host: "db.example ", port: null, driver: "postgres" }),
    ).toBe(false);
    expect(dbDestinationChanged(existing, { options: "" })).toBe(false);
    expect(dbDestinationChanged(existing, { host: "other" })).toBe(true);
    expect(dbDestinationChanged(existing, { port: 1 })).toBe(true);
    expect(dbDestinationChanged(existing, { driver: "mysql" })).toBe(true);
    expect(dbDestinationChanged(existing, { options: '{"host":"x"}' })).toBe(true);
  });

  it("repo: provider and base URL", () => {
    const existing = { provider: "github_enterprise", apiBaseUrl: "https://ghe.example/api/v3" };
    expect(repoDestinationChanged(existing, { apiBaseUrl: "https://GHE.example/api/v3" })).toBe(
      false,
    );
    expect(repoDestinationChanged(existing, { apiBaseUrl: "https://evil.example/api/v3" })).toBe(
      true,
    );
    expect(repoDestinationChanged(existing, { apiBaseUrl: null })).toBe(true);
    expect(repoDestinationChanged(existing, { provider: "github" })).toBe(true);
    expect(repoDestinationChanged(existing, {})).toBe(false);
  });

  it("MCP: every field that picks what runs or where it talks", () => {
    const row = {
      transport: "stdio",
      runtime: null,
      command: "node",
      args: JSON.stringify(["a.js"]),
      url: null,
      headers: null,
      envJson: JSON.stringify({ K: "${vault:x}" }),
      egressAllowlist: null,
    };
    expect(mcpDestinationChanged(row, {})).toBe(false);
    expect(
      mcpDestinationChanged(row, {
        runtime: "native",
        command: "node",
        args: ["a.js"],
        url: null,
        headers: {},
        env: { K: "${vault:x}" },
        egressAllowlist: "",
      }),
    ).toBe(false);
    for (const patch of [
      { runtime: "docker-stdio" },
      { command: "sh" },
      { args: ["b.js"] },
      { url: "https://evil.example" },
      { headers: { X: "1" } },
      { env: { K: "${vault:x}", HTTPS_PROXY: "http://evil" } },
      { env: null },
      { egressAllowlist: "evil.example" },
    ]) {
      expect(mcpDestinationChanged(row, patch), JSON.stringify(patch)).toBe(true);
    }
    expect(mcpDestinationChanged({ ...row, args: "not json" }, { args: ["x"] })).toBe(true);
  });
});
