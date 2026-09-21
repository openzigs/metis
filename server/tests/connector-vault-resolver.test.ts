import { describe, expect, it, vi } from "vitest";
import { asVaultRef, isVaultRef, resolveVaultRef } from "../src/lib/connectors/vault-resolver.js";
import type { VaultService } from "../src/lib/vault/vault-service.js";

function makeVault(opts: {
  read?: (id: string) => Promise<{ plaintext: string }>;
  list?: () => Promise<Array<{ id: string; label: string; scope: string }>>;
}): VaultService {
  return {
    read: opts.read ?? (async () => ({ plaintext: "" })),
    list: opts.list ?? (async () => []),
  } as unknown as VaultService;
}

describe("isVaultRef / asVaultRef", () => {
  it("recognises valid refs", () => {
    expect(isVaultRef("${vault:my-token}")).toBe(true);
    expect(isVaultRef("${vault:project/db-pass}")).toBe(true);
  });

  it("rejects malformed or empty refs", () => {
    expect(isVaultRef("")).toBe(false);
    expect(isVaultRef(null)).toBe(false);
    expect(isVaultRef("vault:my-token")).toBe(false);
    expect(isVaultRef("${vault:}")).toBe(false);
  });

  it("encodes labels into refs", () => {
    expect(asVaultRef("foo")).toBe("${vault:foo}");
  });
});

describe("resolveVaultRef", () => {
  it("returns null for empty/missing input (no credential)", async () => {
    const vault = makeVault({});
    await expect(resolveVaultRef("", vault)).resolves.toBeNull();
    await expect(resolveVaultRef(null, vault)).resolves.toBeNull();
    await expect(resolveVaultRef(undefined, vault)).resolves.toBeNull();
  });

  it("rejects malformed refs as VAULT_REF_INVALID", async () => {
    const vault = makeVault({});
    await expect(resolveVaultRef("not-a-ref", vault)).rejects.toMatchObject({
      code: "VAULT_REF_INVALID",
    });
  });

  it("resolves by id when vault.read succeeds", async () => {
    const vault = makeVault({
      read: vi.fn(async (id: string) => ({ plaintext: `plain-${id}` })),
    });
    await expect(resolveVaultRef("${vault:my-id}", vault)).resolves.toBe("plain-my-id");
  });

  it("falls back to label lookup when read fails", async () => {
    const vault = makeVault({
      read: vi
        .fn()
        .mockRejectedValueOnce(new Error("not found by id"))
        .mockResolvedValueOnce({ plaintext: "by-label" }),
      list: async () => [{ id: "sec_1", label: "my-token", scope: "global" }],
    });
    await expect(resolveVaultRef("${vault:my-token}", vault)).resolves.toBe("by-label");
  });

  it("throws VAULT_REF_UNRESOLVED when both lookups miss", async () => {
    const vault = makeVault({
      read: async () => {
        throw new Error("no such secret");
      },
      list: async () => [],
    });
    await expect(resolveVaultRef("${vault:missing}", vault)).rejects.toMatchObject({
      code: "VAULT_REF_UNRESOLVED",
      status: 500,
    });
  });
});
