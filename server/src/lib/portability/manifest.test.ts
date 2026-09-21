import { describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  assertImportable,
  buildManifest,
  parseManifest,
  type PortabilityManifest,
} from "./manifest.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<Parameters<typeof buildManifest>[0]> = {}) {
  return {
    provider: "sqlite" as const,
    schemaVersion: "1.2.3",
    secretCount: 0,
    envSpecificKeys: [],
    tarball: "metis-export.tar.gz",
    sha256: "abc123",
    ...overrides,
  };
}

// ── buildManifest ─────────────────────────────────────────────────────────────

describe("buildManifest", () => {
  it("sets secretsPresent=false when secretCount=0", () => {
    const m = buildManifest(makeInput({ secretCount: 0 }));
    expect(m.secretsPresent).toBe(false);
  });

  it("sets secretsPresent=true when secretCount>0", () => {
    const m = buildManifest(makeInput({ secretCount: 3 }));
    expect(m.secretsPresent).toBe(true);
    expect(m.secretCount).toBe(3);
  });

  it("always sets vaultKeyIncluded to false", () => {
    const m1 = buildManifest(makeInput({ secretCount: 0 }));
    const m2 = buildManifest(makeInput({ secretCount: 7 }));
    expect(m1.vaultKeyIncluded).toBe(false);
    expect(m2.vaultKeyIncluded).toBe(false);
  });

  it("sets version to 1", () => {
    const m = buildManifest(makeInput());
    expect(m.version).toBe(1);
  });

  it("sets a valid ISO 8601 createdAt timestamp", () => {
    const before = Date.now();
    const m = buildManifest(makeInput());
    const after = Date.now();
    const ts = new Date(m.createdAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(m.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("passes through provider and schemaVersion", () => {
    const m = buildManifest(makeInput({ provider: "postgresql", schemaVersion: "2.0.0" }));
    expect(m.provider).toBe("postgresql");
    expect(m.schemaVersion).toBe("2.0.0");
  });

  it("passes through artifacts", () => {
    const m = buildManifest(makeInput({ tarball: "bundle.tgz", sha256: "deadbeef" }));
    expect(m.artifacts.tarball).toBe("bundle.tgz");
    expect(m.artifacts.sha256).toBe("deadbeef");
  });

  it("passes through envSpecificKeys", () => {
    const keys = ["DB_ALLOWED_HOSTS", "LOCAL_GEMMA_BASE_URL"];
    const m = buildManifest(makeInput({ envSpecificKeys: keys }));
    expect(m.envSpecificKeys).toEqual(keys);
  });
});

// ── parseManifest round-trip ──────────────────────────────────────────────────

describe("parseManifest round-trip", () => {
  it("round-trips a manifest built by buildManifest", () => {
    const original = buildManifest(makeInput({ secretCount: 2 }));
    const parsed = parseManifest(original);
    expect(parsed).toEqual(original);
  });

  it("returns the correct TypeScript shape", () => {
    const m = parseManifest(buildManifest(makeInput()));
    // Type-level: vaultKeyIncluded must be assignable to literal false
    const check: false = m.vaultKeyIncluded;
    expect(check).toBe(false);
  });
});

// ── parseManifest rejection ───────────────────────────────────────────────────

describe("parseManifest rejects invalid input", () => {
  it("throws ManifestValidationError for wrong version", () => {
    const bad = { ...buildManifest(makeInput()), version: 2 };
    expect(() => parseManifest(bad)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError when vaultKeyIncluded is true", () => {
    const bad = { ...buildManifest(makeInput()), vaultKeyIncluded: true };
    expect(() => parseManifest(bad)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for unknown provider", () => {
    const bad = { ...buildManifest(makeInput()), provider: "mysql" };
    expect(() => parseManifest(bad)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError when required fields are missing", () => {
    const bad = { version: 1 }; // missing most fields
    expect(() => parseManifest(bad)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for null input", () => {
    expect(() => parseManifest(null)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for non-ISO createdAt", () => {
    const bad = { ...buildManifest(makeInput()), createdAt: "not-a-date" };
    expect(() => parseManifest(bad)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for negative secretCount", () => {
    const bad = { ...buildManifest(makeInput()), secretCount: -1 };
    expect(() => parseManifest(bad)).toThrow(ManifestValidationError);
  });

  it("error message mentions 'Invalid portability manifest'", () => {
    const bad = { ...buildManifest(makeInput()), version: 99 };
    expect(() => parseManifest(bad)).toThrow(/Invalid portability manifest/);
  });
});

// ── assertImportable ──────────────────────────────────────────────────────────

describe("assertImportable", () => {
  function manifest(secretCount: number): PortabilityManifest {
    return buildManifest(makeInput({ secretCount }));
  }

  it("throws when secretsPresent && !vaultMasterKeyPresent", () => {
    expect(() => assertImportable(manifest(3), { vaultMasterKeyPresent: false })).toThrow(
      /VAULT_MASTER_KEY/,
    );
  });

  it("error message explains secrets will be undecryptable", () => {
    expect(() => assertImportable(manifest(1), { vaultMasterKeyPresent: false })).toThrow(
      /undecryptable/,
    );
  });

  it("error message includes the secret count", () => {
    expect(() => assertImportable(manifest(5), { vaultMasterKeyPresent: false })).toThrow(/5/);
  });

  it("does not throw when secretsPresent && vaultMasterKeyPresent", () => {
    expect(() => assertImportable(manifest(3), { vaultMasterKeyPresent: true })).not.toThrow();
  });

  it("does not throw when no secrets regardless of vault key (false)", () => {
    expect(() => assertImportable(manifest(0), { vaultMasterKeyPresent: false })).not.toThrow();
  });

  it("does not throw when no secrets regardless of vault key (true)", () => {
    expect(() => assertImportable(manifest(0), { vaultMasterKeyPresent: true })).not.toThrow();
  });
});
