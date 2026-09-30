/**
 * #480 — unit tests for binding a vault reference to a secret id at save time
 * (`bindSecretRefs`) and reading only that id at use time (`readBoundSecret`,
 * `expandVaultRefs` with bindings). The end-to-end delete + re-create scenario
 * per resource type is in vault-secret-binding-480.sqlite.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  secrets: [] as Array<{ id: string; name: string; deletedAt: Date | null }>,
  findManyCalls: 0,
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    secret: {
      // A superset of live rows is all the binder needs: it refines in memory.
      findMany: vi.fn(async () => {
        state.findManyCalls += 1;
        return state.secrets.filter((s) => !s.deletedAt);
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          state.secrets.find((s) => s.id === where.id && !s.deletedAt) ?? null,
      ),
    },
  },
}));

const { bindSecretRefs, bindSecretRef, parseSecretBindings } =
  await import("../src/lib/vault/bound-secret.js");
const { readBoundSecret } = await import("../src/lib/connectors/vault-resolver.js");
const { expandVaultRefs } = await import("../src/lib/vault/env-manager.js");

const plaintextOf: Record<string, string> = {};
const vault = {
  read: vi.fn(async (id: string) => {
    const row = state.secrets.find((s) => s.id === id && !s.deletedAt);
    if (!row) throw new Error(`Secret ${id} not found`);
    return { summary: {}, plaintext: plaintextOf[id] };
  }),
  list: vi.fn(async () =>
    state.secrets
      .filter((s) => !s.deletedAt)
      .map((s) => ({
        id: s.id,
        label: s.name.slice(s.name.indexOf(":") + 1),
        scope: s.name.startsWith("project:") ? "project" : "global",
      })),
  ),
} as never;

const secret = (id: string, name: string, value: string) => {
  state.secrets.push({ id, name, deletedAt: null });
  plaintextOf[id] = value;
};
const del = (id: string) => {
  const row = state.secrets.find((s) => s.id === id)!;
  row.deletedAt = new Date();
};

beforeEach(() => {
  state.secrets.length = 0;
  state.findManyCalls = 0;
  vi.clearAllMocks();
});

describe("bindSecretRefs", () => {
  it("binds an id reference to that id, and a unique label to its secret", async () => {
    secret("s1", "global:alpha", "a");
    secret("s2", "project:beta", "b");
    expect(await bindSecretRefs(["s1", "beta", "project:beta", "alpha"])).toEqual({
      s1: "s1",
      beta: "s2",
      "project:beta": "s2",
      alpha: "s1",
    });
    expect(state.findManyCalls).toBe(1);
  });

  it("refuses a label that reaches more than one live secret (409)", async () => {
    secret("s1", "global:x", "a");
    secret("s2", "project:x", "b");
    await expect(bindSecretRef("x")).rejects.toMatchObject({
      statusCode: 409,
      code: "VAULT_REF_AMBIGUOUS",
    });
    // A scope-qualified reference is not ambiguous.
    expect(await bindSecretRef("project:x")).toBe("s2");
  });

  it("refuses a reference that reaches no live secret (400), including a deleted one", async () => {
    secret("s1", "global:gone", "a");
    del("s1");
    await expect(bindSecretRef("gone")).rejects.toMatchObject({
      statusCode: 400,
      code: "VAULT_REF_UNRESOLVED",
    });
    await expect(bindSecretRef("s1")).rejects.toMatchObject({ code: "VAULT_REF_UNRESOLVED" });
  });

  it("keeps a kept reference's binding without re-resolving it, even when stale", async () => {
    secret("s-new", "project:x", "admin");
    const out = await bindSecretRefs(["x"], { x: "s-deleted" });
    expect(out).toEqual({ x: "s-deleted" });
    expect(state.findManyCalls).toBe(0);
  });

  it("resolves only the references a kept map does not cover, once each", async () => {
    secret("s2", "global:y", "y");
    expect(await bindSecretRefs(["x", "y", "y"], { x: "s1", z: "s9" })).toEqual({
      x: "s1",
      y: "s2",
    });
    expect(state.findManyCalls).toBe(1);
  });

  it("treats Object.prototype names as ordinary labels (PR #499 review)", async () => {
    // Legal vault labels: a plain-object lookup would read `constructor` from
    // Object.prototype as a "kept" binding and drop an `__proto__` key.
    secret("s-c", "global:constructor", "c");
    secret("s-p", "global:__proto__", "p");
    secret("s-t", "global:toString", "t");
    const created = await bindSecretRefs(["constructor", "__proto__", "toString"]);
    expect(JSON.parse(JSON.stringify(created))).toEqual({
      constructor: "s-c",
      // Computed key: a literal `__proto__:` would set the prototype, not a key.
      ["__proto__"]: "s-p",
      toString: "s-t",
    });
    // An update with an unrelated kept map still resolves them, not Object's members.
    const updated = await bindSecretRefs(["constructor", "toString"], { other: "s-o" });
    expect(JSON.parse(JSON.stringify(updated))).toEqual({ constructor: "s-c", toString: "s-t" });
  });

  it("reads nothing for no references", async () => {
    expect(await bindSecretRefs([])).toEqual({});
    expect(state.findManyCalls).toBe(0);
  });
});

describe("parseSecretBindings", () => {
  it("reads null as never-bound and a malformed value as binding nothing", () => {
    expect(parseSecretBindings(null)).toBeNull();
    expect(parseSecretBindings(undefined)).toBeNull();
    expect(parseSecretBindings("{not json")).toEqual({});
    expect(parseSecretBindings("[1,2]")).toEqual({});
    expect(parseSecretBindings("null")).toEqual({});
    expect(parseSecretBindings('{"a":"s1","b":2,"c":""}')).toEqual({ a: "s1" });
  });
});

describe("readBoundSecret", () => {
  it("reads a live bound secret by id", async () => {
    secret("s1", "global:x", "value-1");
    expect(await readBoundSecret("s1", vault)).toBe("value-1");
  });

  it("refuses a deleted bound secret and never falls back to a label", async () => {
    secret("s1", "global:x", "value-1");
    del("s1");
    // A live secret whose LABEL is the stale id: a label fallback would pick it.
    secret("s2", "project:s1", "attacker");
    await expect(readBoundSecret("s1", vault)).rejects.toMatchObject({
      status: 409,
      code: "VAULT_BINDING_STALE",
    });
    expect((vault as { list: ReturnType<typeof vi.fn> }).list).not.toHaveBeenCalled();
    expect((vault as { read: ReturnType<typeof vi.fn> }).read).not.toHaveBeenCalled();
  });
});

describe("expandVaultRefs with bindings", () => {
  it("expands each reference from its bound id", async () => {
    secret("s1", "global:x", "value-1");
    expect(
      await expandVaultRefs({ A: "${vault:x}", B: "pre-${vault:x}-post", C: "plain" }, vault, {
        x: "s1",
      }),
    ).toEqual({ A: "value-1", B: "pre-value-1-post", C: "plain" });
    expect((vault as { list: ReturnType<typeof vi.fn> }).list).not.toHaveBeenCalled();
  });

  it("refuses when the bound secret was deleted and the label re-created elsewhere", async () => {
    secret("s1", "global:x", "value-1");
    del("s1");
    secret("s2", "project:x", "admin-value");
    await expect(expandVaultRefs({ A: "${vault:x}" }, vault, { x: "s1" })).rejects.toThrow(
      /bound to has been deleted/,
    );
  });

  it("refuses a reference the bindings do not cover", async () => {
    secret("s1", "global:x", "value-1");
    await expect(expandVaultRefs({ A: "${vault:x}" }, vault, {})).rejects.toThrow(
      /not bound to a secret/,
    );
    // An inherited property name is not a binding.
    await expect(expandVaultRefs({ A: "${vault:toString}" }, vault, {})).rejects.toThrow(
      /not bound to a secret/,
    );
  });

  it("without bindings (a row saved before #480) still resolves by label", async () => {
    secret("s1", "global:x", "value-1");
    expect(await expandVaultRefs({ A: "${vault:x}" }, vault, null)).toEqual({ A: "value-1" });
    expect(await expandVaultRefs({ A: "${vault:x}" }, vault)).toEqual({ A: "value-1" });
  });
});
