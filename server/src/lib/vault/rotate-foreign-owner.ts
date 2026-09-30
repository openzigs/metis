/**
 * #482 — rotating a vault secret someone else owns needs an explicit confirm.
 *
 * `POST /api/vault/:id/rotate` keeps `createdById`, and a secret's owner may
 * already have bound it to a destination they chose (`secret-binding.ts`). An
 * admin who rotates a real value into it sends that value to the owner's host.
 * So the route refuses with 409 {@link VAULT_ROTATE_FOREIGN_OWNER} unless the
 * request sets `confirmForeignOwner: true`, and the refusal names the owner and
 * every resource the secret is bound to so the admin can decide.
 *
 * "Someone else" is a user other than the caller. A secret with no owner
 * (`createdById` null: system-written, or its creator was deleted) belongs to
 * no user, so rotating it is not refused.
 *
 * Bindings are the live resources that hold the secret's id in a column: DB and
 * repo connectors and import sources (`secretId`), MCP servers (`envSecretId`)
 * and Jira connections (`secretId` / `tlsCaSecretId`). References embedded in
 * JSON (MCP env/header `${vault:x}`, test-management auth config) are not
 * enumerated.
 */
import { prisma } from "../prisma.js";

export const VAULT_ROTATE_FOREIGN_OWNER = "VAULT_ROTATE_FOREIGN_OWNER";

export interface SecretOwnerView {
  id: string;
  username: string | null;
  displayName: string | null;
}

export interface SecretBindingView {
  type: "db_connector" | "repo_connector" | "import_source" | "mcp_server" | "jira_connection";
  id: string;
  label: string;
  projectId: string | null;
  /** Where the resource sends the secret (host, base URL, command), when known. */
  destination: string | null;
}

export interface ForeignOwnerDetails {
  secretId: string;
  owner: SecretOwnerView;
  bindings: SecretBindingView[];
}

/** The live secret's owner, or null for an unknown / deleted id. */
export async function secretOwnerOf(
  id: string,
): Promise<{ id: string; createdById: string | null } | null> {
  return prisma.secret.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, createdById: true },
  });
}

/** The owner and live bindings of a secret, for the 409 body and the UI. */
export async function describeForeignOwner(secret: {
  id: string;
  createdById: string;
}): Promise<ForeignOwnerDetails> {
  const [user, dbs, repos, imports, mcps, jiras] = await Promise.all([
    prisma.user.findUnique({
      where: { id: secret.createdById },
      select: { username: true, displayName: true },
    }),
    prisma.databaseConnection.findMany({
      where: { secretId: secret.id, deletedAt: null },
      select: { id: true, label: true, projectId: true, driver: true, host: true, port: true },
    }),
    prisma.repoConnection.findMany({
      where: { secretId: secret.id, deletedAt: null },
      select: { id: true, label: true, projectId: true, provider: true, apiBaseUrl: true },
    }),
    prisma.importSource.findMany({
      where: { secretId: secret.id, deletedAt: null },
      select: { id: true, label: true, projectId: true, source: true, baseUrl: true },
    }),
    prisma.mCPServer.findMany({
      where: { envSecretId: secret.id, deletedAt: null },
      select: { id: true, label: true, projectId: true, url: true, command: true },
    }),
    prisma.jiraConnection.findMany({
      where: {
        deletedAt: null,
        OR: [{ secretId: secret.id }, { tlsCaSecretId: secret.id }],
      },
      select: { id: true, label: true, projectId: true, baseUrl: true },
    }),
  ]);

  const bindings: SecretBindingView[] = [
    ...dbs.map((d) => ({
      type: "db_connector" as const,
      id: d.id,
      label: d.label,
      projectId: d.projectId,
      destination: d.host ? `${d.driver}://${d.host}${d.port ? `:${d.port}` : ""}` : d.driver,
    })),
    ...repos.map((r) => ({
      type: "repo_connector" as const,
      id: r.id,
      label: r.label,
      projectId: r.projectId,
      destination: r.apiBaseUrl ?? r.provider,
    })),
    ...imports.map((i) => ({
      type: "import_source" as const,
      id: i.id,
      label: i.label,
      projectId: i.projectId,
      destination: i.baseUrl ?? i.source,
    })),
    ...mcps.map((m) => ({
      type: "mcp_server" as const,
      id: m.id,
      label: m.label,
      projectId: m.projectId,
      destination: m.url ?? m.command,
    })),
    ...jiras.map((j) => ({
      type: "jira_connection" as const,
      id: j.id,
      label: j.label,
      projectId: j.projectId,
      destination: j.baseUrl,
    })),
  ];

  return {
    secretId: secret.id,
    owner: {
      id: secret.createdById,
      username: user?.username ?? null,
      displayName: user?.displayName ?? null,
    },
    bindings,
  };
}

/** A one-line, human-readable refusal naming the owner and where the secret is bound. */
export function foreignOwnerMessage(details: ForeignOwnerDetails): string {
  const who = details.owner.displayName ?? details.owner.username ?? `user ${details.owner.id}`;
  const where =
    details.bindings.length === 0
      ? "It is not bound to any connector or server."
      : `It is bound to ${details.bindings
          .map((b) => `${b.label}${b.destination ? ` (${b.destination})` : ""}`)
          .join(", ")}.`;
  return (
    `This secret belongs to ${who}. ${where} Rotating it sends your value wherever ` +
    `they have bound it. Set confirmForeignOwner to rotate it anyway.`
  );
}
