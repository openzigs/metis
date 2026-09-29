/**
 * #358 — the #344 binding rule on the publishing paths.
 *
 * `POST /api/projects/:id/github/projects-v2-boards` and a live
 * `POST /api/projects/:projectId/publishing/batches` take both a `secretRef`
 * and a `targetBaseUrl` from the caller, and send the resolved token to that
 * base URL. The SSRF allow-list only refuses private ranges, so a public host
 * the caller controls would receive it. Without `vault.reveal`, a caller may
 * therefore send only a secret they created to a base URL they chose
 * (`lib/vault/secret-binding.ts`).
 *
 * The default public GitHub API (`api.github.com`) is not a caller-chosen
 * destination: the token goes to the service that issued it, which is the
 * use-by-reference the vault permits (#324). A dry run resolves the token only
 * locally (M1 in `publisher.ts`) and sends it nowhere, so callers check only
 * live runs.
 */
import type { AuthPayload } from "@metis/shared";
import { assertSecretBindingAllowed, refBodyOf } from "../vault/secret-binding.js";
import { PUBLIC_GITHUB_HOSTS } from "./host-allowlist.js";

/** True when `baseUrl` names a host other than the public GitHub API. */
export function isCallerChosenPublishHost(baseUrl: string | null | undefined): boolean {
  if (!baseUrl || baseUrl.trim() === "") return false;
  let hostname: string;
  try {
    hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    // Unparseable: resolvePublishTarget rejects it before any token is read,
    // but treat it as caller-chosen so this guard never depends on that order.
    return true;
  }
  return !PUBLIC_GITHUB_HOSTS.has(hostname);
}

/**
 * @throws AppError 403 SECRET_BINDING_FORBIDDEN when a caller without
 *   `vault.reveal` would send a secret they did not create to a base URL they
 *   chose. The refusal is audited as `vault.binding_refused`.
 */
export async function assertPublishSecretBinding(
  user: Pick<AuthPayload, "userId" | "role">,
  input: { secretRef: string | null | undefined; baseUrl: string | null | undefined },
  target: { type: string; id: string },
): Promise<void> {
  if (!isCallerChosenPublishHost(input.baseUrl)) return;
  const body = refBodyOf(input.secretRef);
  await assertSecretBindingAllowed(
    user,
    { before: [], after: body ? [body] : [], destinationChanged: true },
    { target },
  );
}
