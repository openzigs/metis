/**
 * Portability manifest — describes the contents and preconditions of a METIS
 * database/config export bundle.
 *
 * Security invariant: VAULT_MASTER_KEY is NEVER included in the bundle.
 * `vaultKeyIncluded` is a literal `false` that Zod validates at parse time.
 */

import { z } from "zod";

// ── Shape ─────────────────────────────────────────────────────────────────────

export interface PortabilityManifest {
  version: 1;
  createdAt: string; // ISO 8601 timestamp
  provider: "sqlite" | "postgresql";
  schemaVersion: string; // root package.json "version" string
  secretsPresent: boolean;
  secretCount: number;
  /** Invariant: always false — the master key is NEVER bundled. */
  vaultKeyIncluded: false;
  envSpecificKeys: string[];
  artifacts: { tarball: string; sha256: string };
}

// ── Zod schema ────────────────────────────────────────────────────────────────

const PortabilityManifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  provider: z.enum(["sqlite", "postgresql"]),
  schemaVersion: z.string().min(1),
  secretsPresent: z.boolean(),
  secretCount: z.number().int().nonnegative(),
  /** Must be exactly `false` — reject any bundle that claims to contain the master key. */
  vaultKeyIncluded: z.literal(false),
  envSpecificKeys: z.array(z.string()),
  artifacts: z.object({
    tarball: z.string().min(1),
    sha256: z.string().min(1),
  }),
});

// ── Error class ───────────────────────────────────────────────────────────────

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds a {@link PortabilityManifest} from caller-supplied values.
 * Automatically sets:
 *  - `version` to 1
 *  - `createdAt` to the current UTC timestamp
 *  - `secretsPresent` to `secretCount > 0`
 *  - `vaultKeyIncluded` to `false` (invariant)
 */
export function buildManifest(input: {
  provider: PortabilityManifest["provider"];
  schemaVersion: string;
  secretCount: number;
  envSpecificKeys: string[];
  tarball: string;
  sha256: string;
}): PortabilityManifest {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    provider: input.provider,
    schemaVersion: input.schemaVersion,
    secretsPresent: input.secretCount > 0,
    secretCount: input.secretCount,
    vaultKeyIncluded: false,
    envSpecificKeys: input.envSpecificKeys,
    artifacts: {
      tarball: input.tarball,
      sha256: input.sha256,
    },
  };
}

/**
 * Parses and validates an unknown value as a {@link PortabilityManifest}.
 * Throws {@link ManifestValidationError} if the value does not conform.
 */
export function parseManifest(raw: unknown): PortabilityManifest {
  const result = PortabilityManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new ManifestValidationError(
      `Invalid portability manifest: ${result.error.message}`,
      result.error,
    );
  }
  return result.data as PortabilityManifest;
}

/**
 * Asserts that a manifest can be safely imported into the target environment.
 *
 * Throws if the manifest contains secrets (`secretsPresent === true`) but the
 * target environment does not have `VAULT_MASTER_KEY` set. Without the master
 * key, encrypted secrets in the bundle will be permanently undecryptable — the
 * import would produce a partially broken installation.
 */
export function assertImportable(
  m: PortabilityManifest,
  target: { vaultMasterKeyPresent: boolean },
): void {
  if (m.secretsPresent && !target.vaultMasterKeyPresent) {
    throw new Error(
      `IMPORT BLOCKED: This bundle contains ${m.secretCount} encrypted secret(s) ` +
        `but VAULT_MASTER_KEY is not present in the target environment. ` +
        `Without the vault master key, all secrets will be permanently undecryptable ` +
        `and the imported installation will be non-functional. ` +
        `Set VAULT_MASTER_KEY before importing, or export a secrets-free bundle.`,
    );
  }
}
