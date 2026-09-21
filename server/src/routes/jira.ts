/**
 * /api/jira — Jira connection CRUD + test + issue browsing (Epic #556).
 *
 * Connection CRUD:
 *   POST   /connections                    create   (connector.write)
 *   GET    /connections?projectId=X        list     (connector.read)
 *   GET    /connections/:id                detail   (connector.read)
 *   PATCH  /connections/:id                update   (connector.write)
 *   DELETE /connections/:id                delete   (connector.write)
 *   POST   /connections/:id/test           test     (connector.test)
 *
 * Issue browsing:
 *   GET    /connections/:id/projects       list Jira projects  (connector.read)
 *   POST   /connections/:id/search         JQL search          (connector.read)
 *   GET    /connections/:id/issues/:key    issue detail         (connector.read)
 */
import { Router, type Request } from "express";
import {
  type ApiResponse,
  createJiraConnectionSchema,
  updateJiraConnectionSchema,
  jiraSearchRequestSchema,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { assertProjectAccess } from "../lib/custom-agents/authz.js";
import { authorizeJiraConnection } from "../lib/connectors/connection-authz.js";
import { createChildLogger } from "../lib/logger.js";
import { ConnectorError } from "../lib/connectors/types.js";
import type { JiraRawResource } from "../lib/connectors/jira/raw-fetch.js";
import {
  listJiraConnections,
  getJiraConnection,
  createJiraConnection,
  updateJiraConnection,
  deleteJiraConnection,
  testJiraConnection,
  listJiraProjects,
  searchJiraIssues,
  getJiraIssue,
  proxyJiraAttachment,
} from "../lib/connectors/jira/jira-service.js";

const log = createChildLogger("jira-routes");

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

/**
 * Resolve the project that owns `:id` and assert the caller can reach it
 * (#1055). Returns the projectId to scope the service lookup with —
 * `undefined` for system admins, who bypass workspace RBAC.
 *
 * Every `/connections/:id` route, read and write, must call this *before*
 * touching the connection.
 */
function scopeOf(req: Request): Promise<string | undefined> {
  return authorizeJiraConnection(req.user, String(req.params.id));
}

/**
 * Assert access to a caller-supplied `projectId` (create / list). Without this
 * an authenticated user of workspace B could create or enumerate connections
 * under any workspace-A project id.
 */
async function assertCallerProject(req: Request, projectId: string): Promise<void> {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  await assertProjectAccess(req.user, projectId);
}

/**
 * Collapse an allow-list rejection into a single generic 400.
 *
 * #1065 moved the general status mapping into the error handler, so the
 * `JiraApiError` arm this function used to carry is gone — a
 * `JiraApiError(400, INVALID_URL)` now reaches the client as a 400 centrally
 * (and with a sanitised message, which is stricter than the verbatim
 * `err.message` this function used to forward).
 *
 * The `ConnectorError` arm stays, because on *this* route the collapse is a
 * security property, not a status fix. The central path would faithfully
 * surface the connector's own status and code — `403 HOST_NOT_ALLOWED` when a
 * host resolved to a private address versus `502 DNS_LOOKUP_FAILED` when it
 * did not resolve at all. On a route whose URL is fully caller-supplied, that
 * pair is itself an internal-network oracle: it answers "does this internal
 * name exist?" one request at a time. So every allow-list rejection is flattened
 * to one indistinguishable `400 URL_NOT_ALLOWED` (#1062).
 */
function collapseAllowListRejection(err: unknown): unknown {
  if (err instanceof ConnectorError) {
    log.warn("Jira attachment URL rejected by the connector allow-list", {
      code: err.code,
      message: err.message,
    });
    return new AppError(400, "URL_NOT_ALLOWED", "The requested attachment URL is not permitted");
  }
  return err;
}

export function jiraRouter(): Router {
  const r = Router();

  // ── CRUD (#560) ──────────────────────────────────────────────────────

  // POST /api/jira/connections — create
  r.post("/connections", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const projectId = String(req.query.projectId ?? req.body?.projectId ?? "");
    if (!projectId) {
      throw new AppError(400, "PROJECT_REQUIRED", "projectId is required");
    }
    const parsed = createJiraConnectionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
        issues: parsed.error.flatten(),
      });
    }
    await assertCallerProject(req, projectId);
    const created = await createJiraConnection(projectId, parsed.data, actor(req));
    res.status(201).json(ok(created));
  });

  // GET /api/jira/connections?projectId=X — list
  r.get("/connections", requireAuth, requirePermission("connector.read"), async (req, res) => {
    const projectId = String(req.query.projectId ?? "");
    if (!projectId) {
      throw new AppError(400, "PROJECT_REQUIRED", "projectId query param is required");
    }
    await assertCallerProject(req, projectId);
    const list = await listJiraConnections(projectId);
    res.json(ok(list));
  });

  // GET /api/jira/connections/:id — detail
  r.get("/connections/:id", requireAuth, requirePermission("connector.read"), async (req, res) => {
    const scope = await scopeOf(req);
    const detail = await getJiraConnection(String(req.params.id), scope);
    res.json(ok(detail));
  });

  // PATCH /api/jira/connections/:id — update
  r.patch(
    "/connections/:id",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      const parsed = updateJiraConnectionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      const scope = await scopeOf(req);
      const updated = await updateJiraConnection(
        String(req.params.id),
        parsed.data,
        actor(req),
        scope,
      );
      res.json(ok(updated));
    },
  );

  // DELETE /api/jira/connections/:id — soft-delete
  r.delete(
    "/connections/:id",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      const scope = await scopeOf(req);
      await deleteJiraConnection(String(req.params.id), actor(req), scope);
      res.status(204).end();
    },
  );

  // POST /api/jira/connections/:id/test — test connectivity
  r.post(
    "/connections/:id/test",
    requireAuth,
    requirePermission("connector.test"),
    async (req, res) => {
      const scope = await scopeOf(req);
      const result = await testJiraConnection(String(req.params.id), actor(req), scope);
      res.json(ok(result));
    },
  );

  // ── Issue browsing (#561) ────────────────────────────────────────────

  // GET /api/jira/connections/:id/projects — list Jira projects
  r.get(
    "/connections/:id/projects",
    requireAuth,
    requirePermission("connector.read"),
    async (req, res) => {
      const scope = await scopeOf(req);
      const projects = await listJiraProjects(String(req.params.id), scope);
      res.json(ok(projects));
    },
  );

  // POST /api/jira/connections/:id/search — JQL search
  r.post(
    "/connections/:id/search",
    requireAuth,
    requirePermission("connector.read"),
    async (req, res) => {
      const parsed = jiraSearchRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "invalid JQL search payload", {
          issues: parsed.error.flatten(),
        });
      }
      const scope = await scopeOf(req);
      const result = await searchJiraIssues(String(req.params.id), parsed.data, scope);
      res.json(ok(result));
    },
  );

  // GET /api/jira/connections/:id/issues/:key — issue detail
  r.get(
    "/connections/:id/issues/:key",
    requireAuth,
    requirePermission("connector.read"),
    async (req, res) => {
      const scope = await scopeOf(req);
      const detail = await getJiraIssue(String(req.params.id), String(req.params.key), scope);
      res.json(ok(detail));
    },
  );

  // GET /api/jira/connections/:id/attachment-proxy — stream a Jira attachment
  // Query: ?url=<encoded absolute Jira URL>
  //
  // The URL is caller-supplied. `fetchRaw` (see raw-fetch.ts, #1054) enforces
  // parsed-origin equality against the connection baseUrl, the JIRA_ALLOWED_HOSTS
  // allow-list with DNS pinning, per-hop redirect re-validation with the Jira
  // credential scoped to the Jira origin, and a response-size bound. It also
  // returns an already-sanitized Content-Type / Content-Disposition pair, so this
  // route never reflects an untrusted upstream media type.
  r.get(
    "/connections/:id/attachment-proxy",
    requireAuth,
    requirePermission("connector.read"),
    async (req, res) => {
      const url = String(req.query.url ?? "");
      if (!url) {
        throw new AppError(400, "URL_REQUIRED", "url query parameter is required");
      }

      // Authorize the connection BEFORE any outbound fetch (#1055) — and
      // outside the try below, so this 404 is never rewritten by the
      // attachment error mapping.
      const scope = await scopeOf(req);

      let result: JiraRawResource;
      try {
        result = await proxyJiraAttachment(String(req.params.id), url, scope);
      } catch (err) {
        throw collapseAllowListRejection(err);
      }

      res.setHeader("Content-Type", result.contentType);
      if (result.contentLength != null) {
        res.setHeader("Content-Length", result.contentLength);
      }
      res.setHeader("Content-Disposition", result.contentDisposition);
      res.setHeader("X-Content-Type-Options", "nosniff");

      // Pipe the ReadableStream to the Express response. Headers are already
      // committed here, so a mid-stream failure (e.g. the size cap tripping on
      // an upstream that lied about Content-Length) can only be signalled by
      // destroying the connection.
      const reader = result.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- streamed attachment proxy: the URL passes parsed-origin equality against the connection baseUrl plus the connector allow-list, and the Content-Type is restricted to an inline-safe allow-list with everything else forced to application/octet-stream + Content-Disposition: attachment + X-Content-Type-Options: nosniff (set above). A binary stream cannot use res.render().
          res.write(value);
        }
        res.end();
      } catch (err) {
        log.warn("Jira attachment stream aborted", {
          connectionId: String(req.params.id),
          error: err instanceof Error ? err.message : String(err),
        });
        await reader.cancel().catch(() => undefined);
        res.destroy();
      }
    },
  );

  return r;
}
