/**
 * #344 — the DB and repo connector writes that bind a vault secret.
 *
 * A caller without `vault.reveal` may not attach a vault secret they did not
 * create, nor move a connector holding one to another destination (see
 * `lib/vault/secret-binding.ts` for the model). Each guard runs before the
 * service writes anything; an unknown connector id is left to the service's own
 * 404 so the guard adds no existence oracle.
 *
 * #479 — each update guard returns the `updatedAt` of the row it checked
 * (`null` for a create or an unknown id). The route hands it to the service,
 * whose write is conditional on it, so a change landing between the check and
 * the write is a 409 rather than a write the check never saw.
 */
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { assertSecretBindingAllowed, refBodyOf } from "../vault/secret-binding.js";
import {
  dbDestinationChanged,
  jiraDestinationChanged,
  repoDestinationChanged,
  testMgmtDestinationChanged,
} from "./destination.js";

type Caller = Pick<AuthPayload, "userId" | "role">;

/** What a passed connector binding check hands to the route. */
export interface ConnectorBindingCheck {
  /** #479 — the checked row's `updatedAt`; `null` for a create or an unknown id. */
  checkedAt: Date | null;
  /**
   * #552 — the binding-write stamp's window end, or `null` when nothing was
   * stamped; the route calls `assertBindingWriteWindowOpen` with it
   * immediately before the service write.
   */
  until: Date | null;
}

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
    databaseName?: string | null;
    secretRef?: string | null;
  },
): Promise<ConnectorBindingCheck> {
  if (id === null) {
    const until = await assertSecretBindingAllowed(
      user,
      { before: [], after: refs(refBodyOf(input.secretRef)), destinationChanged: true },
      { target: { type: "db_connector", id: "new" }, metadata: { projectId } },
    );
    return { checkedAt: null, until };
  }
  const existing = await prisma.databaseConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!existing) return { checkedAt: null, until: null };
  const until = await assertSecretBindingAllowed(
    user,
    {
      before: refs(existing.secretId),
      after:
        input.secretRef !== undefined ? refs(refBodyOf(input.secretRef)) : refs(existing.secretId),
      destinationChanged: dbDestinationChanged(existing, input),
    },
    { target: { type: "db_connector", id }, metadata: { projectId } },
  );
  return { checkedAt: existing.updatedAt, until };
}

/** The repo-connector counterpart of `assertDbSecretBinding`. */
export async function assertRepoSecretBinding(
  user: Caller,
  projectId: string,
  id: string | null,
  input: { provider?: string | null; apiBaseUrl?: string | null; secretRef?: string | null },
): Promise<ConnectorBindingCheck> {
  if (id === null) {
    const until = await assertSecretBindingAllowed(
      user,
      { before: [], after: refs(refBodyOf(input.secretRef)), destinationChanged: true },
      { target: { type: "repo_connector", id: "new" }, metadata: { projectId } },
    );
    return { checkedAt: null, until };
  }
  const existing = await prisma.repoConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!existing) return { checkedAt: null, until: null };
  const until = await assertSecretBindingAllowed(
    user,
    {
      before: refs(existing.secretId),
      after:
        input.secretRef !== undefined ? refs(refBodyOf(input.secretRef)) : refs(existing.secretId),
      destinationChanged: repoDestinationChanged(existing, input),
    },
    { target: { type: "repo_connector", id }, metadata: { projectId } },
  );
  return { checkedAt: existing.updatedAt, until };
}

/**
 * #358 — Jira and test-management connections store credentials the writer
 * typed in (never a reference), so the question is only whether a PATCH moves
 * credentials someone else supplied. Credentials re-supplied in the same write
 * are the caller's own (the services create them with `createdById` = caller)
 * and so are not checked. `projectId` is `undefined` for admins, who are
 * exempt anyway; an unknown id is left to the service's own 404.
 */
export async function assertJiraSecretBinding(
  user: Caller,
  id: string,
  projectId: string | undefined,
  input: {
    baseUrl?: string;
    proxyUrl?: string | null;
    tlsRejectUnauthorized?: boolean;
    tlsCaCert?: string | null;
    apiToken?: string;
  },
): Promise<ConnectorBindingCheck> {
  const existing = await prisma.jiraConnection.findFirst({
    where: { id, deletedAt: null, ...(projectId ? { projectId } : {}) },
  });
  if (!existing) return { checkedAt: null, until: null };
  const until = await assertSecretBindingAllowed(
    user,
    {
      before: refs(existing.secretId),
      after: input.apiToken ? [] : refs(existing.secretId),
      destinationChanged: jiraDestinationChanged(existing, input),
    },
    { target: { type: "jira_connection", id }, metadata: { projectId: existing.projectId } },
  );
  return { checkedAt: existing.updatedAt, until };
}

/** The credential secret ids a test-management connection's `authConfigJson` holds. */
function testMgmtCredentialIds(authConfigJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authConfigJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  return refs(
    ...Object.values(parsed as Record<string, unknown>).map((v) =>
      typeof v === "string" ? refBodyOf(v) : null,
    ),
  );
}

export async function assertTestMgmtSecretBinding(
  user: Caller,
  id: string,
  projectId: string | undefined,
  input: {
    baseUrl?: string;
    proxyConfig?: { url: string } | null;
    tlsConfig?: { rejectUnauthorized?: boolean; caCert?: string | null } | null;
    auth?: unknown;
  },
): Promise<ConnectorBindingCheck> {
  const existing = await prisma.testManagementConnection.findFirst({
    where: { id, deletedAt: null, ...(projectId ? { projectId } : {}) },
  });
  if (!existing) return { checkedAt: null, until: null };
  const held = testMgmtCredentialIds(existing.authConfigJson);
  const until = await assertSecretBindingAllowed(
    user,
    {
      before: held,
      after: input.auth ? [] : held,
      destinationChanged: testMgmtDestinationChanged(existing, input),
    },
    {
      target: { type: "test_management_connection", id },
      metadata: { projectId: existing.projectId },
    },
  );
  return { checkedAt: existing.updatedAt, until };
}
