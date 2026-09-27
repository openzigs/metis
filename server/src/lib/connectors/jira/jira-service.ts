/**
 * Jira connector service — Epic #556 / Issues #560–#561.
 *
 * CRUD for JiraConnection rows + Jira API operations (test, search, browse).
 * Secrets are stored/retrieved via the vault service; plaintext never persists.
 */
import type {
  CreateJiraConnectionInput,
  UpdateJiraConnectionInput,
  JiraConnectionDetail,
  JiraTestResult,
  JiraProject,
  JiraSearchResult,
  JiraIssueDetail,
  JiraSearchRequest,
} from "@metis/shared";
import { ulid } from "ulid";
import { prisma } from "../../prisma.js";
import { getVaultService } from "../../vault/vault-service.js";
import { audit } from "../../audit/audit-service.js";
import { createChildLogger } from "../../logger.js";
import { ConnectorError } from "../types.js";
import { assertConnectorHostAllowed } from "../network-allowlist.js";
import { createJiraClient, type JiraClient } from "./jira-client.js";
import type { JiraRawResource } from "./raw-fetch.js";

const log = createChildLogger("jira-service");

// ---- Internal helpers ------------------------------------------------------

type JiraRow = Awaited<ReturnType<typeof prisma.jiraConnection.findFirst>> & object;

function toApi(row: JiraRow): JiraConnectionDetail {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    edition: row.edition as JiraConnectionDetail["edition"],
    baseUrl: row.baseUrl,
    username: row.username,
    secretMasked: "••••••••",
    proxyUrl: row.proxyUrl,
    tlsRejectUnauthorized: row.tlsRejectUnauthorized,
    hasTlsCa: Boolean(row.tlsCaSecretId),
    status: row.status as JiraConnectionDetail["status"],
    errorMessage: row.errorMessage,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findOrThrow(id: string, projectId?: string): Promise<JiraRow> {
  const where: Record<string, unknown> = { id, deletedAt: null };
  if (projectId) where.projectId = projectId;
  const row = await prisma.jiraConnection.findFirst({ where });
  if (!row) throw new ConnectorError(404, "JIRA_CONNECTION_NOT_FOUND", "Jira connection not found");
  return row;
}

async function buildClient(row: JiraRow): Promise<JiraClient> {
  // SSRF guard — validate the stored baseUrl before opening any connection.
  // JIRA_ALLOWED_HOSTS (comma-separated) permits private/on-prem Jira hosts.
  const { hostname } = new URL(row.baseUrl);
  await assertConnectorHostAllowed(hostname, "jira");

  const vault = getVaultService();
  const { plaintext: apiToken } = await vault.read(row.secretId);
  let tlsCaCert: string | null = null;
  if (row.tlsCaSecretId) {
    const ca = await vault.read(row.tlsCaSecretId);
    tlsCaCert = ca.plaintext;
  }
  return createJiraClient({
    edition: row.edition as "cloud" | "datacenter",
    baseUrl: row.baseUrl,
    username: row.username,
    apiToken,
    proxyUrl: row.proxyUrl,
    tlsRejectUnauthorized: row.tlsRejectUnauthorized,
    tlsCaCert,
  });
}

// ---- CRUD (#560) -----------------------------------------------------------

/**
 * #106 — a vault label for a NEW Jira secret. `Secret.name` is `@unique` and
 * vault deletes are soft, so a name derived only from project + connection label
 * can already be taken: by a soft-deleted secret, by the secret of a connection
 * that was renamed away from this label, or by another label that sanitizes to
 * the same string ("a b" and "a-b"). Creating under it 500'd on the unique
 * index. A per-secret suffix makes a create unable to collide, and — unlike an
 * upsert on the shared name — never overwrites another connection's live token.
 */
function newJiraSecretLabel(kind: "jira" | "jira-ca", projectId: string, label: string): string {
  return `${kind}-${projectId}-${label}`.replace(/[^a-zA-Z0-9_.-]/g, "-") + `-${ulid()}`;
}

/**
 * #106 — write `value` into the connection's secret `secretId` in place when it
 * is still live; otherwise (none yet, or soft-deleted) create a new one under a
 * collision-free label. Returns the NEW secret's id, or `null` when rotated.
 */
async function rotateOrReplace(
  secretId: string | null,
  value: string,
  fresh: { kind: "jira" | "jira-ca"; projectId: string; label: string; description: string },
): Promise<string | null> {
  const vault = getVaultService();
  if (secretId) {
    const live = await vault.list("project");
    if (live.some((s) => s.id === secretId)) {
      await vault.rotate(secretId, value);
      return null;
    }
  }
  const created = await vault.create(
    newJiraSecretLabel(fresh.kind, fresh.projectId, fresh.label),
    value,
    "project",
    { description: fresh.description },
  );
  return created.id;
}

export async function listJiraConnections(projectId: string): Promise<JiraConnectionDetail[]> {
  const rows = await prisma.jiraConnection.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toApi);
}

export async function getJiraConnection(
  id: string,
  projectId?: string,
): Promise<JiraConnectionDetail> {
  const row = await findOrThrow(id, projectId);
  return toApi(row);
}

export async function createJiraConnection(
  projectId: string,
  input: CreateJiraConnectionInput,
  actorId: string,
): Promise<JiraConnectionDetail> {
  log.info("Creating Jira connection", { projectId, label: input.label, edition: input.edition });
  // Check label uniqueness within project
  const existing = await prisma.jiraConnection.findFirst({
    where: { projectId, label: input.label, deletedAt: null },
  });
  if (existing) {
    throw new ConnectorError(409, "JIRA_LABEL_TAKEN", `label '${input.label}' already exists`);
  }

  // Store the API token in vault
  const vault = getVaultService();
  const secretLabel = newJiraSecretLabel("jira", projectId, input.label);
  const secret = await vault.create(secretLabel, input.apiToken, "project", {
    description: `Jira ${input.edition} API token for ${input.label}`,
  });

  // Store TLS CA cert in vault if provided
  let tlsCaSecretId: string | null = null;
  if (input.tlsCaCert) {
    const caLabel = newJiraSecretLabel("jira-ca", projectId, input.label);
    const caSecret = await vault.create(caLabel, input.tlsCaCert, "project", {
      description: `TLS CA cert for Jira ${input.label}`,
    });
    tlsCaSecretId = caSecret.id;
  }

  const row = await prisma.jiraConnection.create({
    data: {
      projectId,
      label: input.label,
      edition: input.edition,
      baseUrl: input.baseUrl,
      username: input.username,
      secretId: secret.id,
      proxyUrl: input.proxyUrl ?? null,
      tlsRejectUnauthorized: input.tlsRejectUnauthorized ?? true,
      tlsCaSecretId,
      status: "untested",
      createdById: actorId,
    },
  });

  audit({
    actor: { id: actorId },
    action: "connector.jira.create",
    target: { type: "jira_connection", id: row.id },
    metadata: { projectId, edition: input.edition, baseUrl: input.baseUrl },
  });

  return toApi(row);
}

export async function updateJiraConnection(
  id: string,
  input: UpdateJiraConnectionInput,
  actorId: string,
  projectId?: string,
): Promise<JiraConnectionDetail> {
  const existing = await findOrThrow(id, projectId);
  const data: Record<string, unknown> = {};

  if (input.label !== undefined) data.label = input.label;
  if (input.edition !== undefined) data.edition = input.edition;
  if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl;
  if (input.username !== undefined) data.username = input.username;
  if (input.proxyUrl !== undefined) data.proxyUrl = input.proxyUrl;
  if (input.tlsRejectUnauthorized !== undefined)
    data.tlsRejectUnauthorized = input.tlsRejectUnauthorized;

  // #106 — rotate the connection's OWN secrets in place. Re-creating one under
  // the same derived name hit `Secret.name @unique` and 500'd; rotating keeps
  // the id, so nothing is orphaned. A secret deleted out from under the
  // connection (e.g. from the vault admin page) is replaced with a new one
  // instead, since rotating a soft-deleted row would leave it unreadable.
  // Secrets rotated in place leave no key in `data`, so the audit names them here.
  const rotated: string[] = [];
  const label = input.label ?? existing.label;
  if (input.apiToken) {
    const replaced = await rotateOrReplace(existing.secretId, input.apiToken, {
      kind: "jira",
      projectId: existing.projectId,
      label,
      description: `Jira ${input.edition ?? existing.edition} API token for ${label}`,
    });
    if (replaced) data.secretId = replaced;
    else rotated.push("apiToken");
  }

  // Rotate TLS CA cert if provided
  if (input.tlsCaCert !== undefined) {
    if (input.tlsCaCert) {
      const replaced = await rotateOrReplace(existing.tlsCaSecretId, input.tlsCaCert, {
        kind: "jira-ca",
        projectId: existing.projectId,
        label,
        description: `TLS CA cert for Jira ${label}`,
      });
      if (replaced) data.tlsCaSecretId = replaced;
      else rotated.push("tlsCaCert");
    } else {
      data.tlsCaSecretId = null;
    }
  }

  // Reset status on connection-altering changes
  if (
    data.baseUrl ||
    data.secretId ||
    rotated.includes("apiToken") ||
    data.edition ||
    data.username
  ) {
    data.status = "untested";
    data.errorMessage = null;
  }

  const row = await prisma.jiraConnection.update({ where: { id }, data });

  audit({
    actor: { id: actorId },
    action: "connector.jira.update",
    target: { type: "jira_connection", id },
    metadata: { projectId: existing.projectId, fields: [...Object.keys(data), ...rotated] },
  });

  return toApi(row);
}

export async function deleteJiraConnection(
  id: string,
  actorId: string,
  projectId?: string,
): Promise<void> {
  const existing = await findOrThrow(id, projectId);
  await prisma.jiraConnection.update({
    where: { id },
    data: { deletedAt: new Date(), status: "untested" },
  });

  audit({
    actor: { id: actorId },
    action: "connector.jira.delete",
    target: { type: "jira_connection", id },
    metadata: { projectId: existing.projectId },
  });
}

// ---- Operations (#560 test, #561 browse/search) ----------------------------

export async function testJiraConnection(
  id: string,
  actorId: string,
  projectId?: string,
): Promise<JiraTestResult> {
  const row = await findOrThrow(id, projectId);
  const client = await buildClient(row);

  try {
    const result = await client.testConnection();
    await prisma.jiraConnection.update({
      where: { id },
      data: { status: "ok", errorMessage: null, lastTestedAt: new Date() },
    });

    audit({
      actor: { id: actorId },
      action: "connector.jira.test",
      target: { type: "jira_connection", id },
      metadata: { projectId: row.projectId, status: "ok", latencyMs: result.latencyMs },
    });

    return {
      ok: true,
      serverInfo: result.serverInfo,
      latencyMs: result.latencyMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.jiraConnection.update({
      where: { id },
      data: { status: "error", errorMessage: message, lastTestedAt: new Date() },
    });

    audit({
      actor: { id: actorId },
      action: "connector.jira.test",
      target: { type: "jira_connection", id },
      metadata: { projectId: row.projectId, status: "error", errorMessage: message },
    });

    return { ok: false, latencyMs: 0, errorMessage: message };
  }
}

export async function listJiraProjects(id: string, projectId?: string): Promise<JiraProject[]> {
  const row = await findOrThrow(id, projectId);
  const client = await buildClient(row);
  return client.listProjects();
}

export async function searchJiraIssues(
  id: string,
  request: JiraSearchRequest,
  projectId?: string,
): Promise<JiraSearchResult> {
  const row = await findOrThrow(id, projectId);
  const client = await buildClient(row);
  return client.searchIssues(request.jql, {
    startAt: request.startAt,
    maxResults: request.maxResults,
    fields: request.fields,
  });
}

export async function getJiraIssue(
  connectionId: string,
  issueKey: string,
  projectId?: string,
): Promise<JiraIssueDetail> {
  const row = await findOrThrow(connectionId, projectId);
  const client = await buildClient(row);
  return client.getIssue(issueKey, ["renderedFields"]);
}

/**
 * Proxy-fetch a Jira attachment.
 *
 * The URL is caller-supplied, so `fetchRaw` enforces the full SSRF pipeline
 * (#1054): parsed-origin equality against the connection `baseUrl`, the
 * `JIRA_ALLOWED_HOSTS` allow-list with DNS pinning, per-hop redirect
 * re-validation with the credential scoped to the Jira origin, a size bound,
 * and a sanitized `Content-Type` / `Content-Disposition` pair.
 */
export async function proxyJiraAttachment(
  connectionId: string,
  attachmentUrl: string,
  projectId?: string,
): Promise<JiraRawResource> {
  const row = await findOrThrow(connectionId, projectId);
  const client = await buildClient(row);
  return client.fetchRaw(attachmentUrl);
}

/**
 * Build a JiraClient for a given connection ID. Exported for use by the
 * attachment extraction pipeline (Epic #658) which needs direct download
 * access alongside the MCP-based ingest path.
 */
export async function buildJiraClientForConnection(
  connectionId: string,
  projectId?: string,
): Promise<JiraClient> {
  const row = await findOrThrow(connectionId, projectId);
  return buildClient(row);
}
