/**
 * #344 — the DB and repo connector writes that bind a vault secret.
 *
 * A caller without `vault.reveal` may not attach a vault secret they did not
 * create, nor move a connector holding one to another destination (see
 * `lib/vault/secret-binding.ts` for the model). Each guard runs before the
 * service writes anything; an unknown connector id is left to the service's own
 * 404 so the guard adds no existence oracle.
 */
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { assertSecretBindingAllowed, refBodyOf } from "../vault/secret-binding.js";
import { dbDestinationChanged, repoDestinationChanged } from "./destination.js";

type Caller = Pick<AuthPayload, "userId" | "role">;

const refs = (...bodies: Array<string | null | undefined>): string[] =>
  bodies.filter((b): b is string => Boolean(b));

/** `id === null` is a create: every attached secret must be the caller's. */
export async function assertDbSecretBinding(
  user: Caller,
  projectId: string,
  id: string | null,
  input: {
    driver?: string | null;
    host?: string | null;
    port?: number | null;
    options?: string | null;
    secretRef?: string | null;
  },
): Promise<void> {
  if (id === null) {
    await assertSecretBindingAllowed(
      user,
      { before: [], after: refs(refBodyOf(input.secretRef)), destinationChanged: true },
      { target: { type: "db_connector", id: "new" }, metadata: { projectId } },
    );
    return;
  }
  const existing = await prisma.databaseConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!existing) return;
  await assertSecretBindingAllowed(
    user,
    {
      before: refs(existing.secretId),
      after:
        input.secretRef !== undefined ? refs(refBodyOf(input.secretRef)) : refs(existing.secretId),
      destinationChanged: dbDestinationChanged(existing, input),
    },
    { target: { type: "db_connector", id }, metadata: { projectId } },
  );
}

/** The repo-connector counterpart of `assertDbSecretBinding`. */
export async function assertRepoSecretBinding(
  user: Caller,
  projectId: string,
  id: string | null,
  input: { provider?: string | null; apiBaseUrl?: string | null; secretRef?: string | null },
): Promise<void> {
  if (id === null) {
    await assertSecretBindingAllowed(
      user,
      { before: [], after: refs(refBodyOf(input.secretRef)), destinationChanged: true },
      { target: { type: "repo_connector", id: "new" }, metadata: { projectId } },
    );
    return;
  }
  const existing = await prisma.repoConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!existing) return;
  await assertSecretBindingAllowed(
    user,
    {
      before: refs(existing.secretId),
      after:
        input.secretRef !== undefined ? refs(refBodyOf(input.secretRef)) : refs(existing.secretId),
      destinationChanged: repoDestinationChanged(existing, input),
    },
    { target: { type: "repo_connector", id }, metadata: { projectId } },
  );
}
