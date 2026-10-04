/**
 * #763 — an import source may use an EXISTING vault secret, named by
 * `${vault:label}`, instead of a pasted token.
 *
 * The importer sends that token to the tracker's API (or to a caller-chosen
 * `baseUrl` for self-hosted GitHub / Azure DevOps / Linear) and returns what it
 * reads, so attaching a secret here is the #344 binding a repo connector makes:
 * a caller without `vault.reveal` may attach only a secret they created. It is
 * judged as a NEW destination every time (`destinationChanged: true`), with no
 * public-host exemption — unlike issue publishing, a read-back importer turns
 * someone else's token into data the caller can see.
 *
 * The reference is checked and bound to ONE secret id in a single read (#577),
 * and the source stores that id, never the label (#480): a secret deleted and
 * re-created under the same label is not picked up later.
 */
import type { AuthPayload } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import { authorizeAndBindSecretRefs } from "../vault/bound-secret.js";
import { refBodyOf } from "../vault/secret-binding.js";

export interface ImportSecretBinding {
  /** The vault secret id the reference resolved to, or `null` when none was given. */
  secretId: string | null;
  /** #552 — binding-write window end; check it before a persisting write. */
  until: Date | null;
}

/**
 * Authorize and bind an import's `secretRef`. A missing reference binds
 * nothing. Errors are the vault layer's own client-safe `AppError`s; none of
 * them carries secret material (only the reference text the caller sent).
 *
 * @throws AppError 400 VAULT_REF_INVALID, 400 VAULT_REF_UNRESOLVED,
 *   409 VAULT_REF_AMBIGUOUS, 403 SECRET_BINDING_FORBIDDEN (audited),
 *   409 SECRET_BINDING_CHANGED.
 */
export async function authorizeImportSecretRef(
  user: Pick<AuthPayload, "userId" | "role">,
  projectId: string,
  secretRef: string | null | undefined,
  target: { type: string; id: string },
): Promise<ImportSecretBinding> {
  if (secretRef === undefined || secretRef === null || secretRef === "") {
    return { secretId: null, until: null };
  }
  const body = refBodyOf(secretRef);
  if (!body) {
    throw new AppError(400, "VAULT_REF_INVALID", "secretRef must be written as ${vault:label}");
  }
  try {
    const { bindings, until } = await authorizeAndBindSecretRefs(
      user,
      { before: [], after: [body], destinationChanged: true },
      { target, metadata: { projectId } },
    );
    return { secretId: bindings[body] ?? null, until };
  } catch (err) {
    throw withoutReferenceEcho(err);
  }
}

/**
 * The vault layer's unresolved/ambiguous errors quote the reference back. A
 * user who wrapped a real token as `${vault:<token>}` would see it in the
 * response, so those two are re-issued with fixed text (#1094's rule).
 */
const SAFE_MESSAGES: Record<string, string> = {
  VAULT_REF_UNRESOLVED:
    "That vault secret reference does not name a vault secret. Check the label against " +
    "the secrets registered for this workspace.",
  VAULT_REF_AMBIGUOUS:
    "That vault secret label matches more than one secret. Qualify it as " +
    '"${vault:global:label}" or "${vault:project:label}", or use the secret id.',
};

function withoutReferenceEcho(err: unknown): unknown {
  if (err instanceof AppError && err.code in SAFE_MESSAGES) {
    return new AppError(err.statusCode, err.code, SAFE_MESSAGES[err.code]);
  }
  return err;
}
