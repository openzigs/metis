/**
 * Atlassian (Confluence + Jira) ingest connector — Epic #163, Issue #96.
 *
 * Pulls Confluence pages and Jira issues into a project's document store via
 * the official `mcp-atlassian` MCP server. The MCP server is preconfigured
 * in the seed (or any project-scoped override) and supplies:
 *
 *   - `confluence_search(query, spaceKey)` → list of pages
 *   - `confluence_page(pageId)`            → page body (markdown/storage)
 *   - `jira_search(jql)`                   → list of issues
 *   - `jira_issue(issueKey)`               → issue body + comments
 *
 * Each ingested page/issue lands as a `Document` (filename = source URL) in
 * the standard ingest pipeline → quarantine (Epic #157) → indexed under the
 * project ACL. Credentials live in the project's MCP env JSON
 * (`${vault:atlassian-token}` etc.) and never cross the API boundary.
 *
 * Idempotency: re-ingesting an already-pulled page/issue updates the
 * existing Document (matched by filename) — chunks are re-embedded with
 * `KnowledgeService.ingestDocument`, no duplicates accrue.
 */
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { getDocumentStorage } from "../documents/storage.js";
import { getKnowledgeService } from "../rag/knowledge-service.js";
import { getMCPRegistry } from "../mcp/mcp-service.js";
import { redactString } from "./pii-redactor.js";
import { ConnectorError } from "./types.js";
import { buildJiraClientForConnection } from "./jira/jira-service.js";
import {
  extractAttachments,
  renderAttachmentMarkdown,
  type AttachmentMeta,
} from "./jira/attachment-extractor.js";

const log = createChildLogger("atlassian-connector");

/** Default label for the seeded Atlassian MCP server. Project-scoped servers
 * with the same label override the global one. */
export const ATLASSIAN_MCP_LABEL = "mcp-atlassian";

/** Hard caps to prevent a runaway ingest from hammering Atlassian or
 * exhausting LanceDB. The MCP server is also expected to enforce its own
 * pagination, but defence-in-depth applies. */
export const MAX_CONFLUENCE_PAGES = 200;
export const MAX_JIRA_ISSUES = 500;

export interface AtlassianIngestSummary {
  documentsCreated: number;
  documentsUpdated: number;
  chunkCount: number;
  failures: number;
  /** URLs/keys we skipped because they already existed and the body hash
   * matched (e.g. running the same JQL twice in a row). */
  skipped: number;
}

export interface IngestConfluenceInput {
  projectId: string;
  spaceKey: string;
  /** Free-text CQL fragment forwarded to `confluence_search`. */
  query?: string;
  actorId: string;
  /** Override for tests — defaults to the global MCP registry. */
  invokeTool?: ToolInvoker;
  /** Override for tests — defaults to a real DB lookup for the MCP server. */
  resolveServer?: ServerResolver;
}

export interface IngestJiraInput {
  projectId: string;
  jql: string;
  actorId: string;
  invokeTool?: ToolInvoker;
  resolveServer?: ServerResolver;
  /** Optional Jira connection ID — enables attachment downloading via JiraClient. */
  connectionId?: string;
  /** Optional AI provider for image description in attachments. */
  aiProvider?: import("../ai/types.js").AIProvider;
  /** Override for tests — builds a JiraClient from connectionId. */
  buildClient?: (connectionId: string) => Promise<import("./jira/jira-client.js").JiraClient>;
}

export type ToolInvoker = (
  serverId: string,
  toolName: string,
  args: unknown,
) => Promise<{ content: unknown; isError: boolean }>;

export type ServerResolver = (projectId: string) => Promise<{ id: string } | null>;

/**
 * Look up the project-scoped Atlassian MCP server, falling back to the
 * global one. We do NOT auto-create — the admin must seed it (or import it
 * via `/api/mcp/import`) so credentials are vault-managed from day one.
 */
export async function resolveAtlassianMCPServer(projectId: string): Promise<{ id: string } | null> {
  const project = await prisma.mCPServer.findFirst({
    where: {
      label: ATLASSIAN_MCP_LABEL,
      scope: "project",
      projectId,
      deletedAt: null,
      enabled: true,
    },
    select: { id: true },
  });
  if (project) return project;
  const global = await prisma.mCPServer.findFirst({
    where: {
      label: ATLASSIAN_MCP_LABEL,
      scope: "global",
      projectId: null,
      deletedAt: null,
      enabled: true,
    },
    select: { id: true },
  });
  return global;
}

function defaultInvoker(): ToolInvoker {
  return async (serverId, tool, args) => getMCPRegistry().invokeTool(serverId, tool, args);
}

// ---- Tool-output normalization --------------------------------------------
//
// The MCP server returns `content` as either a JSON object (preferred) or a
// `[{type: 'text', text: '<json>'}]` array. We normalize to plain JSON.

export function unwrapMCPContent(raw: unknown): unknown {
  if (raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)) {
    const list = (raw as { content: unknown[] }).content;
    if (list.length === 1 && list[0] && typeof list[0] === "object") {
      const first = list[0] as { type?: string; text?: string };
      if (first.type === "text" && typeof first.text === "string") {
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      }
    }
  }
  return raw;
}

interface ConfluencePageRef {
  id: string;
  title: string;
  url: string;
}

interface ConfluencePageContent extends ConfluencePageRef {
  body: string;
}

interface JiraIssueSummary {
  key: string;
  url: string;
  summary: string;
}

interface JiraIssueContent extends JiraIssueSummary {
  description: string;
  comments: string[];
  status?: string;
  assignee?: string;
}

// ---- Parsers --------------------------------------------------------------

export function parseConfluenceSearch(raw: unknown): ConfluencePageRef[] {
  const data = unwrapMCPContent(raw);
  const results: ConfluencePageRef[] = [];
  const list = pickArray(data, ["results", "pages", "items"]);
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = pickString(obj, ["id", "pageId"]);
    const title = pickString(obj, ["title", "name"]) ?? "(untitled)";
    const url = pickString(obj, ["url", "webui", "_links.webui", "link"]) ?? "";
    if (id) results.push({ id, title, url });
  }
  return results;
}

export function parseConfluencePage(raw: unknown, ref: ConfluencePageRef): ConfluencePageContent {
  const data = unwrapMCPContent(raw);
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const body = pickString(obj, ["body.markdown", "body", "content", "markdown", "text"]) ?? "";
    const title = pickString(obj, ["title"]) ?? ref.title;
    const url = pickString(obj, ["url", "webui"]) ?? ref.url;
    return { id: ref.id, title, url, body };
  }
  return { ...ref, body: typeof data === "string" ? data : "" };
}

export function parseJiraSearch(raw: unknown): JiraIssueSummary[] {
  const data = unwrapMCPContent(raw);
  const list = pickArray(data, ["issues", "results"]);
  const out: JiraIssueSummary[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const key = pickString(obj, ["key", "issueKey", "id"]);
    const url = pickString(obj, ["url", "self", "_links.self"]) ?? "";
    const summary = pickString(obj, ["summary", "fields.summary", "title"]) ?? "(no summary)";
    if (key) out.push({ key, url, summary });
  }
  return out;
}

export function parseJiraIssue(raw: unknown, ref: JiraIssueSummary): JiraIssueContent {
  const data = unwrapMCPContent(raw);
  const obj = (data ?? {}) as Record<string, unknown>;
  const description = pickString(obj, ["description", "fields.description", "body"]) ?? "";
  const summary =
    pickString(obj, ["summary", "fields.summary", "title"]) ?? ref.summary ?? "(no summary)";
  const status = pickString(obj, ["status", "fields.status.name"]) ?? undefined;
  const assignee = pickString(obj, ["assignee", "fields.assignee.displayName"]) ?? undefined;
  const comments: string[] = [];
  const commentList = pickArray(obj, ["comments", "fields.comment.comments"]);
  for (const c of commentList) {
    if (!c) continue;
    if (typeof c === "string") comments.push(c);
    else if (typeof c === "object") {
      const co = c as Record<string, unknown>;
      const text = pickString(co, ["body", "text", "content"]);
      const author = pickString(co, ["author", "author.displayName"]);
      if (text) comments.push(author ? `${author}: ${text}` : text);
    }
  }
  return { ...ref, summary, description, comments, status, assignee };
}

/**
 * Extract attachment metadata from a Jira issue MCP response.
 * The MCP tool returns attachments as metadata objects with filename, size,
 * mimeType, and content URL.
 */
export function parseAttachmentMetas(raw: unknown): AttachmentMeta[] {
  const data = unwrapMCPContent(raw);
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  const list = pickArray(obj, ["attachments", "fields.attachment"]);
  const metas: AttachmentMeta[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const filename = pickString(a, ["filename", "name"]);
    const mimeType =
      pickString(a, ["mimeType", "mime_type", "contentType"]) ?? "application/octet-stream";
    const size = typeof a.size === "number" ? a.size : 0;
    const content = pickString(a, ["content", "url", "self"]);
    if (filename && content) {
      metas.push({ filename, mimeType, size, content });
    }
  }
  return metas;
}

// ---- Main ingest entry points ---------------------------------------------

export async function ingestConfluenceSpace(
  input: IngestConfluenceInput,
): Promise<AtlassianIngestSummary> {
  if (!input.projectId) {
    throw new ConnectorError(400, "PROJECT_REQUIRED", "projectId is required");
  }
  if (!input.spaceKey) {
    throw new ConnectorError(400, "SPACE_REQUIRED", "spaceKey is required");
  }
  const resolveServer = input.resolveServer ?? resolveAtlassianMCPServer;
  const server = await resolveServer(input.projectId);
  if (!server) {
    throw new ConnectorError(
      404,
      "MCP_SERVER_NOT_CONFIGURED",
      `MCP server '${ATLASSIAN_MCP_LABEL}' is not configured for this project`,
    );
  }
  const invoke = input.invokeTool ?? defaultInvoker();

  const searchRaw = await invoke(server.id, "confluence_search", {
    spaceKey: input.spaceKey,
    query: input.query ?? "",
  });
  if (searchRaw.isError) {
    throw new ConnectorError(
      502,
      "MCP_TOOL_ERROR",
      `confluence_search failed for space ${input.spaceKey}`,
    );
  }
  const refs = parseConfluenceSearch(searchRaw.content).slice(0, MAX_CONFLUENCE_PAGES);

  const summary: AtlassianIngestSummary = {
    documentsCreated: 0,
    documentsUpdated: 0,
    chunkCount: 0,
    failures: 0,
    skipped: 0,
  };

  for (const ref of refs) {
    try {
      const pageRaw = await invoke(server.id, "confluence_page", { pageId: ref.id });
      if (pageRaw.isError) {
        summary.failures += 1;
        continue;
      }
      const page = parseConfluencePage(pageRaw.content, ref);
      const filename = `confluence:${input.spaceKey}:${page.id}`;
      const body = renderConfluenceMarkdown(page);
      await ingestUnit({
        projectId: input.projectId,
        actorId: input.actorId,
        filename,
        body,
        summary,
      });
    } catch (err) {
      summary.failures += 1;
      log.warn("confluence ingest page failed", {
        pageId: ref.id,
        err: (err as Error).message,
      });
    }
  }
  audit({
    actor: { id: input.actorId },
    action: "connector.atlassian.confluence.ingest",
    target: { type: "project", id: input.projectId },
    metadata: {
      spaceKey: input.spaceKey,
      pages: refs.length,
      ...summary,
    },
  });
  return summary;
}

export async function ingestJiraQuery(input: IngestJiraInput): Promise<AtlassianIngestSummary> {
  if (!input.projectId) {
    throw new ConnectorError(400, "PROJECT_REQUIRED", "projectId is required");
  }
  if (!input.jql || !input.jql.trim()) {
    throw new ConnectorError(400, "JQL_REQUIRED", "jql is required");
  }
  const resolveServer = input.resolveServer ?? resolveAtlassianMCPServer;
  const server = await resolveServer(input.projectId);
  if (!server) {
    throw new ConnectorError(
      404,
      "MCP_SERVER_NOT_CONFIGURED",
      `MCP server '${ATLASSIAN_MCP_LABEL}' is not configured for this project`,
    );
  }
  const invoke = input.invokeTool ?? defaultInvoker();

  const searchRaw = await invoke(server.id, "jira_search", { jql: input.jql });
  if (searchRaw.isError) {
    throw new ConnectorError(502, "MCP_TOOL_ERROR", `jira_search failed for jql`);
  }
  const refs = parseJiraSearch(searchRaw.content).slice(0, MAX_JIRA_ISSUES);

  const summary: AtlassianIngestSummary = {
    documentsCreated: 0,
    documentsUpdated: 0,
    chunkCount: 0,
    failures: 0,
    skipped: 0,
  };

  // Build a JiraClient for attachment downloading if connectionId is provided
  const clientBuilder = input.buildClient ?? buildJiraClientForConnection;
  const jiraClient = input.connectionId
    ? await clientBuilder(input.connectionId).catch((err) => {
        log.warn("Failed to build JiraClient for attachments", { err: (err as Error).message });
        return null;
      })
    : null;

  for (const ref of refs) {
    try {
      const issueRaw = await invoke(server.id, "jira_issue", { issueKey: ref.key });
      if (issueRaw.isError) {
        summary.failures += 1;
        continue;
      }
      const issue = parseJiraIssue(issueRaw.content, ref);

      // Extract attachment content if JiraClient is available
      let attachmentMd = "";
      if (jiraClient) {
        const attachmentMetas = parseAttachmentMetas(issueRaw.content);
        if (attachmentMetas.length > 0) {
          try {
            const extractions = await extractAttachments({
              client: jiraClient,
              attachments: attachmentMetas,
              aiProvider: input.aiProvider,
            });
            attachmentMd = renderAttachmentMarkdown(extractions);
          } catch (err) {
            log.warn("Attachment extraction failed for issue", {
              key: ref.key,
              err: (err as Error).message,
            });
          }
        }
      }

      const filename = `jira:${ref.key}`;
      const body = renderJiraMarkdown(issue, attachmentMd || undefined);
      await ingestUnit({
        projectId: input.projectId,
        actorId: input.actorId,
        filename,
        body,
        summary,
      });
    } catch (err) {
      summary.failures += 1;
      log.warn("jira ingest issue failed", { key: ref.key, err: (err as Error).message });
    }
  }
  audit({
    actor: { id: input.actorId },
    action: "connector.atlassian.jira.ingest",
    target: { type: "project", id: input.projectId },
    metadata: { jql: input.jql, issues: refs.length, ...summary },
  });
  return summary;
}

// ---- Markdown renderers ---------------------------------------------------

export function renderConfluenceMarkdown(page: ConfluencePageContent): string {
  const lines: string[] = [];
  lines.push(`# ${page.title}`);
  if (page.url) lines.push("", `Source: ${page.url}`);
  lines.push("");
  lines.push(page.body || "(empty page)");
  return redactString(lines.join("\n"));
}

export function renderJiraMarkdown(issue: JiraIssueContent, attachmentMarkdown?: string): string {
  const lines: string[] = [];
  lines.push(`# ${issue.key}: ${issue.summary}`);
  if (issue.url) lines.push("", `Source: ${issue.url}`);
  if (issue.status) lines.push(`Status: ${issue.status}`);
  if (issue.assignee) lines.push(`Assignee: ${issue.assignee}`);
  lines.push("", "## Description", "", issue.description || "(no description)");
  if (issue.comments.length > 0) {
    lines.push("", "## Comments");
    for (const c of issue.comments) lines.push("", `- ${c}`);
  }
  if (attachmentMarkdown) {
    lines.push("", attachmentMarkdown);
  }
  return redactString(lines.join("\n"));
}

// ---- Shared ingest unit ---------------------------------------------------

interface IngestUnitArgs {
  projectId: string;
  actorId: string;
  filename: string;
  body: string;
  summary: AtlassianIngestSummary;
}

async function ingestUnit(args: IngestUnitArgs): Promise<void> {
  const storage = getDocumentStorage();
  const knowledge = getKnowledgeService();
  const buffer = Buffer.from(args.body, "utf-8");
  const blob = await storage.write({ projectId: args.projectId, buffer });
  const existing = await prisma.document.findFirst({
    where: { projectId: args.projectId, filename: args.filename, deletedAt: null },
  });
  let docId: string;
  if (existing) {
    if (existing.checksum === blob.checksum) {
      args.summary.skipped += 1;
      return;
    }
    await prisma.document.update({
      where: { id: existing.id },
      data: {
        storagePath: blob.storagePath,
        checksum: blob.checksum,
        sizeBytes: blob.sizeBytes,
        status: "pending",
        errorMessage: null,
      },
    });
    docId = existing.id;
    args.summary.documentsUpdated += 1;
  } else {
    const created = await prisma.document.create({
      data: {
        projectId: args.projectId,
        filename: args.filename,
        mimeType: "text/markdown",
        sizeBytes: blob.sizeBytes,
        storagePath: blob.storagePath,
        checksum: blob.checksum,
        status: "pending",
        uploadedById: args.actorId,
      },
    });
    docId = created.id;
    args.summary.documentsCreated += 1;
  }
  const result = await knowledge.ingestDocument(docId);
  if (result.status === "ready") args.summary.chunkCount += result.chunkCount;
  else if (result.status === "failed") args.summary.failures += 1;
}

// ---- Helpers --------------------------------------------------------------

function pickString(obj: Record<string, unknown>, paths: string[]): string | null {
  for (const p of paths) {
    const v = readPath(obj, p);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function pickArray(obj: unknown, paths: string[]): unknown[] {
  if (!obj || typeof obj !== "object") return [];
  if (Array.isArray(obj)) return obj;
  const o = obj as Record<string, unknown>;
  for (const p of paths) {
    const v = readPath(o, p);
    if (Array.isArray(v)) return v;
  }
  return [];
}

function readPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- read-only traversal: this only reads nested values from a parsed API response into a local variable; it never assigns into an object, so prototype pollution is not possible.
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
