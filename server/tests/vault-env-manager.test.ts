/**
 * Vault env-manager: ${vault:...} reference expansion.
 */
import { describe, expect, it } from "vitest";
import type { VaultService } from "../src/lib/vault/vault-service.js";
import { expandVaultRefs } from "../src/lib/vault/env-manager.js";

function fakeVault(secrets: Record<string, string>): VaultService {
  return {
    async read(id: string) {
      if (!(id in secrets)) throw new Error("not found");
      return { plaintext: secrets[id], summary: {} as never };
    },
    async list() {
      return Object.entries(secrets).map(([id, value]) => ({
        id,
        label: id,
        description: "",
        scope: "global" as const,
        keyVersion: 1,
        algorithm: "aes-256-gcm",
        createdAt: new Date(),
        updatedAt: new Date(),
        // The label is the full ref "id" so plain-label refs work below.
        _value: value,
      })) as never;
    },
  } as unknown as VaultService;
}

describe("expandVaultRefs", () => {
  it("returns env unchanged when no refs are present", async () => {
    const out = await expandVaultRefs({ FOO: "bar", PORT: "4000" }, fakeVault({}));
    expect(out).toEqual({ FOO: "bar", PORT: "4000" });
  });

  it("resolves a single ${vault:id} reference", async () => {
    const v = fakeVault({ "github-token": "gho_xxx" });
    const out = await expandVaultRefs({ GITHUB_TOKEN: "${vault:github-token}" }, v);
    expect(out.GITHUB_TOKEN).toBe("gho_xxx");
  });

  it("resolves multiple references in one value", async () => {
    const v = fakeVault({ a: "first", b: "second" });
    const out = await expandVaultRefs({ COMBINED: "${vault:a}-${vault:b}" }, v);
    expect(out.COMBINED).toBe("first-second");
  });

  it("throws when a reference cannot be resolved", async () => {
    const v = fakeVault({});
    await expect(expandVaultRefs({ X: "${vault:does-not-exist}" }, v)).rejects.toThrow(
      /could not be resolved/,
    );
  });
});
