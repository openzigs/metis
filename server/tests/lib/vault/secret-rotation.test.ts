/**
 * #258 — the shared write pattern for vault callers: rotate the entity's own
 * secret by id; only a missing or soft-deleted secret falls back to a new one,
 * and that one gets a label no earlier secret can hold.
 */
import { describe, expect, it, vi } from "vitest";
import { freshSecretLabel, rotateOrCreate } from "../../../src/lib/vault/secret-rotation.js";
import { SecretNotFoundError } from "../../../src/lib/vault/vault-service.js";

function vaultDouble() {
  return {
    rotate: vi.fn(async (id: string) => ({ id })),
    create: vi.fn(async (label: string) => ({ id: `new:${label}` })),
  };
}
const fresh = { label: "base", scope: "project" as const, description: "d", createdById: "u1" };

describe("freshSecretLabel", () => {
  it("appends a unique ULID suffix to the base", () => {
    const a = freshSecretLabel("base");
    const b = freshSecretLabel("base");
    expect(a).toMatch(/^base-[0-9A-Z]{26}$/);
    expect(a).not.toBe(b);
  });
});

describe("rotateOrCreate", () => {
  it("rotates a live secret in place and creates nothing", async () => {
    const vault = vaultDouble();
    await expect(rotateOrCreate(vault as never, "sec_1", "v", fresh)).resolves.toEqual({
      id: "sec_1",
      created: false,
    });
    expect(vault.rotate).toHaveBeenCalledWith("sec_1", "v");
    expect(vault.create).not.toHaveBeenCalled();
  });

  it("creates under a fresh label when the secret is missing or soft-deleted", async () => {
    const vault = vaultDouble();
    vault.rotate.mockRejectedValueOnce(new SecretNotFoundError("sec_1"));
    const out = await rotateOrCreate(vault as never, "sec_1", "v", fresh);
    expect(out.created).toBe(true);
    const [label, value, scope, opts] = vault.create.mock.calls[0] as unknown as [
      string,
      string,
      string,
      unknown,
    ];
    expect(label).toMatch(/^base-[0-9A-Z]{26}$/);
    expect(out.id).toBe(`new:${label}`);
    expect([value, scope]).toEqual(["v", "project"]);
    expect(opts).toEqual({ description: "d", createdById: "u1" });
  });

  it("creates without trying to rotate when there is no secret yet", async () => {
    const vault = vaultDouble();
    const out = await rotateOrCreate(vault as never, null, "v", {
      ...fresh,
      createdById: undefined,
    });
    expect(out.created).toBe(true);
    expect(vault.rotate).not.toHaveBeenCalled();
    expect(vault.create.mock.calls[0]![3]).toEqual({ description: "d", createdById: null });
  });

  it("propagates any other vault failure instead of minting a new secret", async () => {
    const vault = vaultDouble();
    vault.rotate.mockRejectedValueOnce(new Error("db down"));
    await expect(rotateOrCreate(vault as never, "sec_1", "v", fresh)).rejects.toThrow("db down");
    expect(vault.create).not.toHaveBeenCalled();
  });
});
