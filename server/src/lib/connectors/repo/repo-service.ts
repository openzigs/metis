/**
 * Repo connector service — Phase 8 (issue #60).
 *
 * Fetches per-repo metadata via Octokit (works against github.com OR an
 * Enterprise instance via `apiBaseUrl`):
 *
 *   - repository details (default branch, languages, archive flag)
 *   - top-level directory listing
 *   - README + key configs (package.json/pyproject.toml/pom.xml/go.mod/requirements.txt/Dockerfile)
 *
 * Optional shallow clone (off by default; opt-in `withClone=true`) uses
 * `simple-git` to materialise a depth=1 working copy under
 * `REPO_CLONE_DIR/<connectorId>` so deeper analyses can iterate the file tree.
 * Total clone size is capped (`MAX_REPO_CLONE_BYTES`). Tmp dir is cleaned on
 * any failure path.
 *
 * NEVER logs the resolved PAT. Octokit instances are constructed per call so
 * we don't keep credential material in memory longer than necessary.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MAX_REPO_CLONE_BYTES,
  MAX_REPO_INDEX_FILE_BYTES,
  REPO_PROVIDER_LOCAL,
  REPO_PROVIDER_UPLOAD,
  type CreateRepoConnectorInput,
  type RepoProvider,
  type UpdateRepoConnectorInput,
} from "@metis/shared";
import { audit } from "../../audit/audit-service.js";
import { createChildLogger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import { getVaultService } from "../../vault/vault-service.js";
import { resolveRepoCloneRoot, resolveRepoClonePath } from "./clone-path.js";
import { assertConnectorHostAllowed, resolveAndAssertConnectorHost } from "../network-allowlist.js";
import { ConnectorError, NOOP_EMITTER, type ConnectorEmitter } from "../types.js";
import { isDriverDetailCode, sanitizeDriverError } from "../driver-error.js";
import { resolveVaultRef } from "../vault-resolver.js";
import { validateLocalSourcePath } from "./local-source.js";
import {
  cleanupExtraction,
  extractArchiveBuffer,
  extractArchiveFromPath,
  storeUploadedArchive,
} from "./archive-extract.js";

const log = createChildLogger("repo-service");

/**
 * Resolve the hard cap on a shallow repo clone's on-disk size.
 *
 * Defaults to the shared {@link MAX_REPO_CLONE_BYTES} (100 MiB) but is tunable
 * PER DEPLOYMENT via the `REPO_CLONE_MAX_BYTES` env var (a positive integer
 * count of bytes) — the 100 MiB constant was previously un-overridable, which
 * blocked deep-ingest of legitimately large repositories. An absent, blank, or
 * invalid (non-integer / non-positive) value falls back to the default, with a
 * warning. Raising this raises the disk/memory a single ingest may consume, so
 * it is an explicit operator opt-in, not a default change.
 */
export function resolveRepoCloneMaxBytes(): number {
  const raw = process.env.REPO_CLONE_MAX_BYTES?.trim();
  if (!raw) return MAX_REPO_CLONE_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    log.warn("Ignoring invalid REPO_CLONE_MAX_BYTES; falling back to the default cap", {
      value: raw,
      defaultBytes: MAX_REPO_CLONE_BYTES,
    });
    return MAX_REPO_CLONE_BYTES;
  }
  return parsed;
}

// ---- Octokit + git factories (test injectable) -----------------------------

export interface OctokitLike {
  rest: {
    repos: {
      get: (params: { owner: string; repo: string }) => Promise<{
        data: {
          id: number;
          name: string;
          full_name: string;
          default_branch: string;
          private: boolean;
          archived: boolean;
          size: number;
          language: string | null;
        };
      }>;
      listLanguages: (params: { owner: string; repo: string }) => Promise<{
        data: Record<string, number>;
      }>;
      getReadme: (params: { owner: string; repo: string }) => Promise<{
        data: { content: string; encoding: string };
      }>;
      getContent: (params: { owner: string; repo: string; path: string; ref?: string }) => Promise<{
        data:
          | { type: "file"; encoding: string; content: string; path: string; size: number }
          | Array<{ type: "dir" | "file"; name: string; path: string; size: number }>;
      }>;
      listCommits: (params: {
        owner: string;
        repo: string;
        per_page?: number;
      }) => Promise<{ data: Array<{ sha: string }> }>;
    };
  };
}

export interface OctokitFactoryArgs {
  baseUrl?: string;
  token?: string;
  /** Pre-validated IP for the API host (M1 — DNS rebinding defence). */
  pinnedAddress?: string;
  pinnedFamily?: 4 | 6;
  /** The validated hostname `pinnedAddress` belongs to — needed to check NO_PROXY. */
  hostname?: string;
}
export type OctokitFactory = (args: OctokitFactoryArgs) => OctokitLike;

let octokitFactoryOverride: OctokitFactory | null = null;
export function __setOctokitFactory(factory: OctokitFactory | null): void {
  octokitFactoryOverride = factory;
}

async function defaultOctokit(args: OctokitFactoryArgs): Promise<OctokitLike> {
  const { Octokit } = (await import("@octokit/rest")) as unknown as {
    Octokit: new (cfg: unknown) => OctokitLike;
  };
  const cfg: Record<string, unknown> = {
    userAgent: "metis-connector/1.0",
    // Use the v3 Accept header so older GitHub Enterprise Server instances
    // (which return 406 for the newer `application/vnd.github+json` header
    // sent by @octokit/request ≥ 10) still respond correctly.
    headers: { accept: "application/vnd.github.v3+json" },
  };
  if (args.baseUrl) cfg.baseUrl = args.baseUrl;
  if (args.token) cfg.auth = args.token;
  // @octokit/request ≥10 uses `globalThis.fetch` (undici) and only reads
  // `fetch`/`log`/`parseSuccessResponseBody`/`redirect`/`signal` off
  // `request` — a plain `agent`/`timeout` (the config this replaced) is
  // silently ignored. Supplying our OWN `fetch` is the only way to attach a
  // dispatcher, which is what BOTH DNS pinning (M1) and routing public
  // GitHub hosts through a corporate egress proxy need — the latter matters
  // because Node's `fetch`, unlike `curl`/`git`, never reads
  // HTTP_PROXY/HTTPS_PROXY on its own, so a network that requires a forward
  // proxy for public internet egress otherwise hangs every request until it
  // times out (observed live against a GitHub EMU org connector, 2026-09).
  if (args.pinnedAddress && args.hostname) {
    const [{ fetch: undiciFetch }, { resolveConnectorDispatcher }] = await Promise.all([
      import("undici"),
      import("../network-allowlist.js"),
    ]);
    const dispatcher = await resolveConnectorDispatcher({
      hostname: args.hostname,
      address: args.pinnedAddress,
      family: args.pinnedFamily ?? 4,
    });
    cfg.request = {
      fetch: (url: string, init: RequestInit) =>
        undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]),
    };
  }
  return new Octokit(cfg);
}

export interface SimpleGitLike {
  clone(repoUrl: string, target: string, options?: string[]): Promise<unknown>;
  env?: (envVars: Record<string, string>) => SimpleGitLike;
}
export type SimpleGitFactory = (cwd: string) => SimpleGitLike;
let gitFactoryOverride: SimpleGitFactory | null = null;
export function __setSimpleGitFactory(factory: SimpleGitFactory | null): void {
  gitFactoryOverride = factory;
}
async function defaultGit(cwd: string): Promise<SimpleGitLike> {
  const mod = (await import("simple-git")) as unknown as {
    simpleGit: (c: string, opts?: Record<string, unknown>) => SimpleGitLike;
  };
  // simple-git blocks GIT_CONFIG_COUNT/_KEY_n/_VALUE_n by default (same class
  // of guard as allowUnsafeAskPass/allowUnsafeEditor) — opt in since
  // `basicAuthConfigEnv` relies on it to carry the auth header.
  return mod.simpleGit(cwd, { unsafe: { allowUnsafeConfigEnvCount: true } });
}

// Builds env vars that make git send `Authorization: Basic <token>` on every
// request via Git's env-var config mechanism (`GIT_CONFIG_COUNT`/`_KEY_n`/
// `_VALUE_n`, Git >=2.31) instead of `-c http.extraHeader=...` on the CLI —
// the `-c` form would land in `ps` output same as a URL-embedded token would.
// GIT_ASKPASS was tried first and does not work here: a manual repro with an
// IDENTICAL askpass script, same token, same proxy, failed with
// "remote: Repository not found", while the same token sent as a request
// header (no 401-challenge-then-retry) succeeded (observed live, 2026-09-10).
function basicAuthConfigEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

// ---- Service deps + emitter -----------------------------------------------

export interface RepoServiceDeps {
  emitter?: ConnectorEmitter;
}
let depsRef: RepoServiceDeps = {};
export function configureRepoConnectorService(deps: RepoServiceDeps): void {
  depsRef = deps;
}
function emitter(): ConnectorEmitter {
  return depsRef.emitter ?? NOOP_EMITTER;
}
/** Expose emitter for use by route-level discovery notifications (#669). */
export function getRepoConnectorEmitter(): ConnectorEmitter {
  return emitter();
}

// ---- CRUD ------------------------------------------------------------------

export async function listRepoConnectors(projectId: string) {
  const rows = await prisma.repoConnection.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toApi);
}

export async function getRepoConnector(projectId: string, id: string) {
  const row = await prisma.repoConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!row) {
    throw new ConnectorError(404, "REPO_CONNECTOR_NOT_FOUND", "repo connector not found");
  }
  return toApi(row);
}

/**
 * Issue #288 — narrow a connector to a git provider, asserting it carries the
 * owner/repo identifiers the GitHub code paths require. The `local`/`upload`
 * providers have no owner/repo and must NOT reach Octokit / git-clone logic, so
 * this throws a 400 for them (defense in depth — routes already branch first).
 */
function assertGitConnector(conn: {
  provider: string;
  ownerOrOrg: string | null;
  repoName: string | null;
}): {
  ownerOrOrg: string;
  repoName: string;
} {
  if (conn.provider === REPO_PROVIDER_LOCAL || conn.provider === REPO_PROVIDER_UPLOAD) {
    throw new ConnectorError(
      400,
      "NOT_GIT_PROVIDER",
      "This operation is only available for git providers",
    );
  }
  if (!conn.ownerOrOrg || !conn.repoName) {
    throw new ConnectorError(400, "REPO_IDENTIFIER_MISSING", "connector is missing owner/repo");
  }
  return { ownerOrOrg: conn.ownerOrOrg, repoName: conn.repoName };
}

export async function createRepoConnector(
  projectId: string,
  input: CreateRepoConnectorInput,
  actorId: string,
) {
  const exists = await prisma.repoConnection.findFirst({
    where: { projectId, label: input.label, deletedAt: null },
  });
  if (exists) {
    throw new ConnectorError(409, "REPO_LABEL_TAKEN", `label '${input.label}' already exists`);
  }
  if (input.apiBaseUrl) assertHttpsUrl(input.apiBaseUrl);

  const provider = (input.provider ?? "github") as RepoProvider;

  // Issue #288 — provider="local": validate the server path against the
  // LOCAL_SOURCE_ROOTS allowlist (realpath + containment) BEFORE persisting.
  // We store the RESOLVED realpath so the connector always references the same
  // real directory it was authorized against. Route-layer enforces admin authZ.
  let localPath: string | null = null;
  if (provider === REPO_PROVIDER_LOCAL) {
    if (!input.localPath) {
      throw new ConnectorError(
        400,
        "LOCAL_PATH_REQUIRED",
        "localPath is required for provider=local",
      );
    }
    const validated = await validateLocalSourcePath(input.localPath);
    localPath = validated.realPath;
  }

  const secretLabel = input.secretRef ? extractRefBody(input.secretRef) : null;
  let secretId: string | null = null;
  if (secretLabel) {
    // Vault names are scoped as "global:<label>" or "project:<label>"
    const secret = await prisma.secret.findFirst({
      where: {
        OR: [
          { name: secretLabel },
          { name: `global:${secretLabel}` },
          { name: `project:${secretLabel}` },
        ],
        deletedAt: null,
      },
    });
    if (!secret) {
      throw new ConnectorError(
        404,
        "VAULT_SECRET_NOT_FOUND",
        `vault secret '${secretLabel}' not found`,
      );
    }
    secretId = secret.id;
  }
  const row = await prisma.repoConnection.create({
    data: {
      projectId,
      label: input.label,
      provider,
      ownerOrOrg: input.ownerOrOrg ?? null,
      repoName: input.repoName ?? null,
      localPath,
      defaultBranch: input.defaultBranch ?? "main",
      apiBaseUrl: input.apiBaseUrl ?? null,
      secretId,
      status: "pending",
      createdById: actorId,
    },
  });

  // Epic #640 — auto-set isPrimary if this is the first repo for the project.
  const repoCount = await prisma.repoConnection.count({
    where: { projectId, deletedAt: null },
  });
  if (repoCount === 1) {
    await prisma.repoConnection.update({
      where: { id: row.id },
      data: { isPrimary: true },
    });
    row.isPrimary = true;
  }

  audit({
    actor: { id: actorId },
    action: "connector.repo.create",
    target: { type: "repo_connector", id: row.id },
    metadata: { projectId, provider: row.provider, repo: repoSourceLabel(row) },
  });
  return toApi(row);
}

/**
 * Issue #288 — create an `upload` repo connector from an uploaded .zip buffer.
 *
 * The archive is persisted (so re-ingest can re-extract without re-upload) and
 * extracted ONCE up front to fail fast on a malformed / oversized / zip-slip
 * archive. AuthZ (project write) is enforced at the route layer.
 */
export async function createUploadRepoConnector(
  projectId: string,
  label: string,
  archive: Buffer,
  actorId: string,
) {
  const exists = await prisma.repoConnection.findFirst({
    where: { projectId, label, deletedAt: null },
  });
  if (exists) {
    throw new ConnectorError(409, "REPO_LABEL_TAKEN", `label '${label}' already exists`);
  }

  const row = await prisma.repoConnection.create({
    data: {
      projectId,
      label,
      provider: REPO_PROVIDER_UPLOAD,
      ownerOrOrg: null,
      repoName: null,
      defaultBranch: "main",
      status: "pending",
      createdById: actorId,
    },
  });

  // Persist the archive + validate it now (zip-slip / zip-bomb guards run here).
  let uploadPath: string;
  try {
    uploadPath = await storeUploadedArchive(row.id, archive);
    await extractArchiveBuffer(row.id, archive);
  } catch (err) {
    // Roll back the connector row so a bad upload leaves no orphan.
    await prisma.repoConnection.delete({ where: { id: row.id } }).catch(() => undefined);
    await cleanupExtraction(row.id).catch(() => undefined);
    throw err;
  }
  await prisma.repoConnection.update({ where: { id: row.id }, data: { uploadPath } });
  row.uploadPath = uploadPath;

  const repoCount = await prisma.repoConnection.count({
    where: { projectId, deletedAt: null },
  });
  if (repoCount === 1) {
    await prisma.repoConnection.update({ where: { id: row.id }, data: { isPrimary: true } });
    row.isPrimary = true;
  }

  audit({
    actor: { id: actorId },
    action: "connector.repo.create",
    target: { type: "repo_connector", id: row.id },
    metadata: { projectId, provider: row.provider, repo: repoSourceLabel(row) },
  });
  return toApi(row);
}

/**
 * Issue #288 — resolve the directory a connector's ingest should walk.
 *
 *   - `local`  → the validated realpath (re-validated against the allowlist on
 *     every call so a path that has since fallen out of LOCAL_SOURCE_ROOTS, or
 *     been repointed via symlink, is rejected at ingest time too).
 *   - `upload` → a fresh extraction of the stored archive (re-extract on every
 *     ingest; zip-slip / zip-bomb guards re-run each time).
 *
 * Returns `{ path, boundary }`. `boundary` is set for `local` so the source
 * walk skips symlinks that escape the validated directory. Throws for git
 * providers (callers must use the clone path instead).
 */
export async function resolveNonGitIngestRoot(
  projectId: string,
  id: string,
): Promise<{ path: string; boundary?: string }> {
  const conn = await prisma.repoConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!conn) {
    throw new ConnectorError(404, "REPO_CONNECTOR_NOT_FOUND", "repo connector not found");
  }
  if (conn.provider === REPO_PROVIDER_LOCAL) {
    if (!conn.localPath) {
      throw new ConnectorError(400, "LOCAL_PATH_MISSING", "connector has no localPath");
    }
    const validated = await validateLocalSourcePath(conn.localPath);
    return { path: validated.realPath, boundary: validated.realPath };
  }
  if (conn.provider === REPO_PROVIDER_UPLOAD) {
    if (!conn.uploadPath) {
      throw new ConnectorError(400, "UPLOAD_MISSING", "connector has no stored archive");
    }
    const result = await extractArchiveFromPath(id, conn.uploadPath);
    return { path: result.dir };
  }
  throw new ConnectorError(400, "NOT_NON_GIT_PROVIDER", "connector is not a local/upload provider");
}

/** Human label of a connector's source for audit metadata (no PII / no path). */
function repoSourceLabel(row: {
  provider: string;
  ownerOrOrg: string | null;
  repoName: string | null;
}): string {
  if (row.provider === REPO_PROVIDER_LOCAL) return "(local-path)";
  if (row.provider === REPO_PROVIDER_UPLOAD) return "(upload)";
  return `${row.ownerOrOrg ?? ""}/${row.repoName ?? ""}`;
}

export async function updateRepoConnector(
  projectId: string,
  id: string,
  patch: Omit<UpdateRepoConnectorInput, "id">,
  actorId: string,
) {
  const existing = await prisma.repoConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!existing) throw new ConnectorError(404, "REPO_CONNECTOR_NOT_FOUND", "not found");
  const data: Record<string, unknown> = {};
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.provider !== undefined) data.provider = patch.provider;
  if (patch.ownerOrOrg !== undefined) data.ownerOrOrg = patch.ownerOrOrg;
  if (patch.repoName !== undefined) data.repoName = patch.repoName;
  if (patch.defaultBranch !== undefined) data.defaultBranch = patch.defaultBranch;
  if (patch.apiBaseUrl !== undefined) {
    if (patch.apiBaseUrl) assertHttpsUrl(patch.apiBaseUrl);
    data.apiBaseUrl = patch.apiBaseUrl;
  }
  if (patch.secretRef !== undefined) {
    const patchLabel = patch.secretRef ? extractRefBody(patch.secretRef) : null;
    if (patchLabel) {
      const secret = await prisma.secret.findFirst({
        where: {
          OR: [
            { name: patchLabel },
            { name: `global:${patchLabel}` },
            { name: `project:${patchLabel}` },
          ],
          deletedAt: null,
        },
      });
      if (!secret) {
        throw new ConnectorError(
          404,
          "VAULT_SECRET_NOT_FOUND",
          `vault secret '${patchLabel}' not found`,
        );
      }
      data.secretId = secret.id;
    } else {
      data.secretId = null;
    }
  }
  const row = await prisma.repoConnection.update({ where: { id }, data });
  audit({
    actor: { id: actorId },
    action: "connector.repo.update",
    target: { type: "repo_connector", id },
    metadata: { projectId, fields: Object.keys(data) },
  });
  return toApi(row);
}

export async function deleteRepoConnector(projectId: string, id: string, actorId: string) {
  const existing = await prisma.repoConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!existing) throw new ConnectorError(404, "REPO_CONNECTOR_NOT_FOUND", "not found");
  await prisma.repoConnection.update({
    where: { id },
    data: { deletedAt: new Date(), status: "disabled" },
  });
  audit({
    actor: { id: actorId },
    action: "connector.repo.delete",
    target: { type: "repo_connector", id },
    metadata: { projectId },
  });
}

// ---- Primary repo helpers --------------------------------------------------

/**
 * Set a repo connector as the primary for its project. Atomically clears
 * any existing primary on the same project before setting the new one.
 */
export async function setPrimaryRepo(projectId: string, id: string, actorId: string) {
  const existing = await prisma.repoConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!existing) {
    throw new ConnectorError(404, "REPO_CONNECTOR_NOT_FOUND", "repo connector not found");
  }
  // Already primary — return as-is
  if (existing.isPrimary) return toApi(existing);

  // Atomic swap: clear old primary, set new one
  await prisma.$transaction([
    prisma.repoConnection.updateMany({
      where: { projectId, isPrimary: true, deletedAt: null },
      data: { isPrimary: false },
    }),
    prisma.repoConnection.update({
      where: { id },
      data: { isPrimary: true },
    }),
  ]);
  const updated = await prisma.repoConnection.findUniqueOrThrow({ where: { id } });
  audit({
    actor: { id: actorId },
    action: "connector.repo.set_primary",
    target: { type: "repo_connector", id },
    metadata: { projectId, repo: repoSourceLabel(updated) },
  });
  return toApi(updated);
}

/**
 * Return the primary repo connector for a project, or null if none is set.
 */
export async function getPrimaryRepo(projectId: string) {
  const row = await prisma.repoConnection.findFirst({
    where: { projectId, isPrimary: true, deletedAt: null },
  });
  return row ? toApi(row) : null;
}

// ---- Operations ------------------------------------------------------------

export async function testRepoConnector(projectId: string, id: string, actorId: string) {
  const conn = await getRepoConnector(projectId, id);
  const git = assertGitConnector(conn);
  await assertHostFromBaseUrl(conn.apiBaseUrl);
  const start = Date.now();
  try {
    const octokit = await acquireOctokit(conn.apiBaseUrl, conn.secretRef);
    emitter().progress({
      connectorId: id,
      projectId,
      kind: "repo",
      phase: "test",
      step: "repo.get",
    });
    const repoData = await octokit.rest.repos.get({
      owner: git.ownerOrOrg,
      repo: git.repoName,
    });
    const latencyMs = Date.now() - start;
    await prisma.repoConnection.update({
      where: { id },
      data: {
        status: "connected",
        lastTestedAt: new Date(),
        errorMessage: null,
        defaultBranch: repoData.data.default_branch,
      },
    });
    emitter().status({ connectorId: id, kind: "repo", status: "connected" });
    audit({
      actor: { id: actorId },
      action: "connector.repo.test",
      target: { type: "repo_connector", id },
      metadata: { projectId, latencyMs, repo: `${git.ownerOrOrg}/${git.repoName}` },
    });
    return {
      ok: true,
      latencyMs,
      defaultBranch: repoData.data.default_branch,
      private: repoData.data.private,
      archived: repoData.data.archived,
      sizeKb: repoData.data.size,
    };
  } catch (err) {
    const ce = toOctokitError(err);
    // #1084 — the host allow-list raises `HOST_NOT_ALLOWED` / `DNS_LOOKUP_*`
    // naming the private address a caller-supplied host resolved to, and
    // `toOctokitError` passes a `ConnectorError` straight through. The message
    // is returned, persisted, AND emitted, so it is sanitized once here.
    const safeMessage = safeRepoErrorMessage(ce);
    await prisma.repoConnection.update({
      where: { id },
      data: { status: "error", errorMessage: safeMessage, lastTestedAt: new Date() },
    });
    emitter().status({ connectorId: id, kind: "repo", status: "error", errorMessage: safeMessage });
    audit({
      actor: { id: actorId },
      action: "connector.repo.test",
      target: { type: "repo_connector", id },
      metadata: { projectId, status: "error", code: ce.code },
    });
    throw ce;
  }
}

export interface RepoMetadata {
  repo: { full_name: string; default_branch: string; size: number };
  languages: Record<string, number>;
  topLevel: Array<{ type: "dir" | "file"; name: string; path: string; size: number }>;
  readme: string | null;
  manifests: Record<string, string>;
  headSha: string | null;
}

const KEY_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "Cargo.toml",
  "Dockerfile",
  "docker-compose.yml",
  "Gemfile",
];

export async function fetchRepoMetadata(
  projectId: string,
  id: string,
  actorId: string,
): Promise<RepoMetadata> {
  const conn = await getRepoConnector(projectId, id);
  const git = assertGitConnector(conn);
  await assertHostFromBaseUrl(conn.apiBaseUrl);
  const octokit = await acquireOctokit(conn.apiBaseUrl, conn.secretRef);

  emitter().progress({ connectorId: id, projectId, kind: "repo", phase: "metadata", step: "repo" });
  const repo = await octokit.rest.repos.get({ owner: git.ownerOrOrg, repo: git.repoName });

  emitter().progress({
    connectorId: id,
    projectId,
    kind: "repo",
    phase: "metadata",
    step: "languages",
  });
  const languages = await octokit.rest.repos.listLanguages({
    owner: git.ownerOrOrg,
    repo: git.repoName,
  });

  emitter().progress({ connectorId: id, projectId, kind: "repo", phase: "metadata", step: "tree" });
  const tree = await octokit.rest.repos
    .getContent({ owner: git.ownerOrOrg, repo: git.repoName, path: "" })
    .catch(() => ({
      data: [] as Array<{ type: "dir" | "file"; name: string; path: string; size: number }>,
    }));
  const topLevel = Array.isArray(tree.data) ? tree.data : [];

  emitter().progress({
    connectorId: id,
    projectId,
    kind: "repo",
    phase: "metadata",
    step: "readme",
  });
  let readme: string | null = null;
  try {
    const r = await octokit.rest.repos.getReadme({ owner: git.ownerOrOrg, repo: git.repoName });
    readme = decodeContent(r.data.content, r.data.encoding);
  } catch {
    readme = null;
  }

  emitter().progress({
    connectorId: id,
    projectId,
    kind: "repo",
    phase: "metadata",
    step: "manifests",
  });
  const manifests: Record<string, string> = {};
  for (const m of KEY_MANIFESTS) {
    const present = topLevel.find((t) => t.type === "file" && t.name === m);
    if (!present) continue;
    if (present.size > MAX_REPO_INDEX_FILE_BYTES) continue;
    try {
      const f = await octokit.rest.repos.getContent({
        owner: git.ownerOrOrg,
        repo: git.repoName,
        path: m,
      });
      const fd = f.data;
      if (!Array.isArray(fd) && fd.type === "file") {
        manifests[m] = decodeContent(fd.content, fd.encoding);
      }
    } catch {
      /* skip */
    }
  }

  let headSha: string | null = null;
  try {
    const commits = await octokit.rest.repos.listCommits({
      owner: git.ownerOrOrg,
      repo: git.repoName,
      per_page: 1,
    });
    headSha = commits.data[0]?.sha ?? null;
  } catch {
    headSha = null;
  }

  await prisma.repoConnection.update({
    where: { id },
    data: { lastCommitSha: headSha, status: "connected", errorMessage: null },
  });
  audit({
    actor: { id: actorId },
    action: "connector.repo.metadata",
    target: { type: "repo_connector", id },
    metadata: {
      projectId,
      languageCount: Object.keys(languages.data).length,
      manifestCount: Object.keys(manifests).length,
      headSha: headSha ?? "(unknown)",
    },
  });

  return {
    repo: {
      full_name: repo.data.full_name,
      default_branch: repo.data.default_branch,
      size: repo.data.size,
    },
    languages: languages.data,
    topLevel,
    readme,
    manifests,
    headSha,
  };
}

export interface ShallowCloneResult {
  path: string;
  sizeBytes: number;
}

/**
 * The parent-process env vars the `git` clone/pull subprocess needs — just
 * enough for network egress (a corporate forward proxy) and basic execution,
 * NOT the operator's whole environment. Blanket-forwarding `process.env`
 * pulled in unrelated dev-machine vars (e.g. `GIT_EDITOR`) that simple-git's
 * OWN safety guard then rejects ("not permitted without enabling
 * allowUnsafeEditor"), and there is no reason a connector-driven clone of an
 * attacker-influenced repo URL should see the operator's full shell env
 * (SSH agent vars, npm tokens, etc.) in the first place.
 */
const FORWARDED_GIT_ENV_VARS = [
  "PATH",
  "HOME",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

function forwardedGitEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORWARDED_GIT_ENV_VARS) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export async function shallowCloneRepo(
  projectId: string,
  id: string,
  actorId: string,
): Promise<ShallowCloneResult> {
  const conn = await getRepoConnector(projectId, id);
  const gitRepo = assertGitConnector(conn);
  // #777 — the ONE source of truth for the clone path. Previously derived inline
  // here and, differently, in the analysis orchestrator; the two disagreed.
  const root = resolveRepoCloneRoot();
  await fs.mkdir(root, { recursive: true });
  const target = resolveRepoClonePath(id);
  // Always start clean.
  await fs.rm(target, { recursive: true, force: true });

  // Re-resolve and re-validate the host RIGHT BEFORE invoking git so a
  // DNS-rebinding attacker has the smallest possible window. Git itself uses
  // libcurl's resolver — pinning at that layer would require GIT_HTTP_PROXY
  // shenanigans we don't want to maintain. Document the residual TOCTOU.
  await assertHostFromBaseUrl(conn.apiBaseUrl);

  const cloneUrl = buildCloneUrl({
    ...conn,
    ownerOrOrg: gitRepo.ownerOrOrg,
    repoName: gitRepo.repoName,
  });
  const token = await resolveSecret(conn.secretRef);

  // L1 — DO NOT embed the PAT in the clone URL: it would persist in
  // `.git/config`'s remote.origin.url, readable by anything that later
  // touches the clone. Send it as a Basic auth header instead (see
  // `basicAuthConfigEnv`) — never written to any file, never in argv.
  let cloneEnv: Record<string, string> = {};
  if (token) {
    // `simple-git#env(obj)` REPLACES the spawned process's entire environment
    // rather than merging with it — passing just the overrides below
    // silently wiped PATH/HOME/HTTPS_PROXY/HTTP_PROXY/NO_PROXY from every
    // authenticated clone. On a network that requires a forward proxy for
    // public-internet egress, `git` (unlike a bare env-blind client) DOES
    // read HTTP_PROXY/HTTPS_PROXY natively — but only if they survive into
    // its spawn env, which they never did here. Symptom: `git clone` to a
    // public GitHub host hangs until libcurl's own timeout and fails with
    // "Recv failure: Operation timed out" (observed live, 2026-09-10).
    cloneEnv = {
      ...forwardedGitEnv(),
      ...basicAuthConfigEnv(token),
      GIT_TERMINAL_PROMPT: "0",
      // Disable libcurl's netrc lookup so a rogue ~/.netrc can't override us.
      GIT_CONFIG_NOSYSTEM: "1",
    };
  }

  // M6 — cap clone size BEFORE the working tree exists by combining
  // `--depth=1` with `--filter=blob:limit=<size>` (Git ≥ 2.36) to avoid
  // downloading any single blob bigger than `MAX_REPO_CLONE_BYTES`. The
  // partial-clone filter is a server-side limit, so a hostile mirror that
  // ignores it is still bounded by the post-clone `dirSize` check below.
  const cloneMaxBytes = resolveRepoCloneMaxBytes();
  const cloneArgs: string[] = [
    "--depth=1",
    "--single-branch",
    `--branch=${conn.defaultBranch}`,
    `--filter=blob:limit=${cloneMaxBytes}`,
    "--no-tags",
  ];

  const baseGit = gitFactoryOverride ? gitFactoryOverride(root) : await defaultGit(root);
  const git: SimpleGitLike =
    cloneEnv && Object.keys(cloneEnv).length > 0 && typeof baseGit.env === "function"
      ? baseGit.env(cloneEnv)
      : baseGit;

  try {
    await git.clone(cloneUrl, target, cloneArgs);
  } catch (err) {
    await fs.rm(target, { recursive: true, force: true });
    audit({
      actor: { id: actorId },
      action: "connector.repo.clone.failed",
      target: { type: "repo_connector", id },
      metadata: { projectId, code: "CLONE_FAILED" },
    });
    throw new ConnectorError(502, "CLONE_FAILED", `git clone failed: ${(err as Error).message}`);
  }

  const sizeBytes = await dirSize(target, cloneMaxBytes);
  if (sizeBytes > cloneMaxBytes) {
    await fs.rm(target, { recursive: true, force: true });
    throw new ConnectorError(
      413,
      "CLONE_TOO_LARGE",
      `repo clone exceeded the clone-size cap (${sizeBytes} > ${cloneMaxBytes} bytes). ` +
        `Raise REPO_CLONE_MAX_BYTES to ingest a larger repository.`,
    );
  }
  audit({
    actor: { id: actorId },
    action: "connector.repo.clone",
    target: { type: "repo_connector", id },
    metadata: { projectId, sizeBytes, path: target.replace(os.homedir(), "~") },
  });
  return { path: target, sizeBytes };
}

export interface PullOrCloneResult extends ShallowCloneResult {
  /** true = existing clone was updated via `git pull`, false = fresh clone */
  pulled: boolean;
  /** Number of files changed by the pull (0 on a fresh clone or up-to-date branch). */
  filesChanged: number;
}

/**
 * If a clone already exists for this connector, runs `git pull --ff-only` to
 * fast-forward to the latest branch head.  Falls back to a full `shallowCloneRepo`
 * if the clone dir is missing, corrupt, or diverged (non-fast-forwardable).
 *
 * Returns the same `path` + `sizeBytes` as `shallowCloneRepo`, plus a `pulled`
 * flag so callers can decide whether to force a full re-ingest.
 */
export async function pullOrCloneRepo(
  projectId: string,
  id: string,
  actorId: string,
): Promise<PullOrCloneResult> {
  // #777 — same shared helper as the clone path above and as the analysis side.
  const target = resolveRepoClonePath(id);

  // Check if a working clone already exists.
  let hasClone = false;
  try {
    await fs.access(path.join(target, ".git"));
    hasClone = true;
  } catch {
    hasClone = false;
  }

  if (!hasClone) {
    const result = await shallowCloneRepo(projectId, id, actorId);
    return { ...result, pulled: false, filesChanged: 0 };
  }

  // Existing clone — set up credentials and attempt `git pull --ff-only`.
  const conn = await getRepoConnector(projectId, id);
  const token = await resolveSecret(conn.secretRef);

  // Same auth mechanism as `shallowCloneRepo`'s `cloneEnv` — see
  // `basicAuthConfigEnv` for why GIT_ASKPASS was replaced.
  let pullEnv: Record<string, string> = {};
  if (token) {
    pullEnv = {
      // Same fix as `shallowCloneRepo`'s `cloneEnv` — `simple-git#env(obj)`
      // REPLACES rather than merges the spawned env, so PATH/HTTPS_PROXY/etc.
      // must be forwarded explicitly or a proxied network's `git pull` hangs.
      ...forwardedGitEnv(),
      ...basicAuthConfigEnv(token),
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    };
  }

  try {
    // simple-git is constructed on the clone target dir for pull operations.
    const baseGit = gitFactoryOverride ? gitFactoryOverride(target) : await defaultGit(target);
    const git: SimpleGitLike & { pull?: (...a: unknown[]) => Promise<{ files: string[] }> } =
      Object.keys(pullEnv).length > 0 && typeof baseGit.env === "function"
        ? (baseGit.env(pullEnv) as typeof git)
        : (baseGit as typeof git);

    let filesChanged = 0;
    if (typeof git.pull === "function") {
      const pullResult = await git.pull("origin", conn.defaultBranch, ["--ff-only"]);
      filesChanged = pullResult?.files?.length ?? 0;
    }

    const sizeBytes = await dirSize(target);
    audit({
      actor: { id: actorId },
      action: "connector.repo.pull",
      target: { type: "repo_connector", id },
      metadata: { projectId, sizeBytes, filesChanged },
    });
    return { path: target, sizeBytes, pulled: true, filesChanged };
  } catch (pullErr) {
    // Pull failed (diverged, shallow history too short, corrupt, etc.) — fall
    // back to a fresh clone. Log at warn so ops can see it without alarming.
    log.warn(
      `git pull failed for connector ${id} — falling back to fresh clone: ${(pullErr as Error).message}`,
    );
    const result = await shallowCloneRepo(projectId, id, actorId);
    return { ...result, pulled: false, filesChanged: 0 };
  }
}

// ---- Helpers ---------------------------------------------------------------

async function acquireOctokit(apiBaseUrl: string | null, secretRef: string): Promise<OctokitLike> {
  // Normalize GHE base URL: users may paste a browse URL like
  // "https://git.example.com/Org/repo/tree/main" or just the host
  // "https://git.example.com". Octokit needs "{origin}/api/v3".
  let normalizedBase = apiBaseUrl;
  if (normalizedBase) {
    try {
      const parsed = new URL(normalizedBase);
      // If the path already ends with /api/v3, keep it as-is.
      // Otherwise, use just the origin + /api/v3.
      if (!parsed.pathname.replace(/\/+$/, "").endsWith("/api/v3")) {
        normalizedBase = parsed.origin + "/api/v3";
      } else {
        normalizedBase = parsed.origin + parsed.pathname.replace(/\/+$/, "");
      }
    } catch {
      // If URL parsing fails, pass through as-is (will fail at Octokit level)
    }
  }
  const token = (await resolveSecret(secretRef)) ?? undefined;
  const host = normalizedBase ? hostnameOrThrow(normalizedBase) : "api.github.com";
  const pinned = await resolveAndAssertConnectorHost(host, "repo");
  const args: OctokitFactoryArgs = {
    baseUrl: normalizedBase ?? undefined,
    token,
    pinnedAddress: pinned.address,
    pinnedFamily: pinned.family,
    hostname: pinned.hostname,
  };
  return octokitFactoryOverride ? octokitFactoryOverride(args) : await defaultOctokit(args);
}

async function resolveSecret(secretRef: string): Promise<string | null> {
  if (!secretRef) return null;
  const vault = getVaultService();
  return resolveVaultRef(secretRef, vault);
}

async function assertHostFromBaseUrl(apiBaseUrl: string | null): Promise<void> {
  const host = apiBaseUrl ? hostnameOrThrow(apiBaseUrl) : "api.github.com";
  await assertConnectorHostAllowed(host, "repo");
}

function hostnameOrThrow(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    throw new ConnectorError(400, "INVALID_BASE_URL", `apiBaseUrl is not a valid URL: ${raw}`);
  }
}

function assertHttpsUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError(400, "INVALID_BASE_URL", `apiBaseUrl is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new ConnectorError(400, "INSECURE_BASE_URL", `apiBaseUrl must use HTTPS: ${raw}`);
  }
}

function decodeContent(content: string, encoding: string): string {
  if (encoding === "base64") {
    return Buffer.from(content, "base64").toString("utf-8");
  }
  return content;
}

function buildCloneUrl(conn: {
  provider: string;
  apiBaseUrl: string | null;
  ownerOrOrg: string;
  repoName: string;
}): string {
  const host = conn.apiBaseUrl ? hostnameOrThrow(conn.apiBaseUrl) : "github.com";
  return `https://${host}/${conn.ownerOrOrg}/${conn.repoName}.git`;
}

// `earlyExitOver` lets the sum stop as soon as it provably exceeds the cap
// (an optimization for huge trees). It MUST be the SAME cap the caller checks
// against (#REPO_CLONE_MAX_BYTES) — otherwise an oversized repo could be
// undercounted and slip past the post-clone check.
async function dirSize(
  dir: string,
  earlyExitOver: number = resolveRepoCloneMaxBytes(),
): Promise<number> {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          const stat = await fs.stat(p);
          total += stat.size;
          if (total > earlyExitOver) return total;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

function toApi(row: {
  id: string;
  projectId: string;
  label: string;
  provider: string;
  ownerOrOrg: string | null;
  repoName: string | null;
  localPath?: string | null;
  uploadPath?: string | null;
  defaultBranch: string;
  isPrimary: boolean;
  apiBaseUrl: string | null;
  secretId: string | null;
  status: string;
  errorMessage: string | null;
  lastTestedAt: Date | null;
  lastIngestAt: Date | null;
  lastCommitSha: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    provider: row.provider,
    ownerOrOrg: row.ownerOrOrg,
    repoName: row.repoName,
    // Issue #288 / OWASP A01 — never expose raw server filesystem paths or
    // archive paths in the read DTO. Callers (incl. plain `connector.read`
    // readers) only need to know a source exists, not where it lives on disk.
    // Mirror how `secretId` is redacted into `secretRef`: surface a boolean
    // presence flag instead of the value. The path itself stays server-side and
    // is read straight from the DB row by `resolveNonGitIngestRoot`.
    hasLocalSource: Boolean(row.localPath),
    hasUploadArchive: Boolean(row.uploadPath),
    defaultBranch: row.defaultBranch,
    isPrimary: row.isPrimary,
    apiBaseUrl: row.apiBaseUrl,
    secretRef: row.secretId ? `\${vault:${row.secretId}}` : "",
    status: row.status,
    errorMessage: row.errorMessage,
    lastTestedAt: row.lastTestedAt,
    lastIngestAt: row.lastIngestAt,
    lastCommitSha: row.lastCommitSha,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function extractRefBody(ref: string): string | null {
  const m = /^\$\{vault:([^}]+)\}$/.exec(ref);
  if (!m) {
    throw new ConnectorError(
      400,
      "VAULT_REF_INVALID",
      "secretRef must be `${vault:label}` or empty",
    );
  }
  return m[1];
}

/**
 * Issue #1084 — client-safe replacement for an allow-list / network message.
 * The raw string stays in the server log; application-level messages (auth,
 * not-found, rate-limit) are passed through untouched.
 */
function safeRepoErrorMessage(err: ConnectorError): string {
  if (!isDriverDetailCode(err.code)) return err.message;
  log.warn("repo connector network error sanitized before persistence", {
    code: err.code,
    rawError: err.message,
  });
  return sanitizeDriverError(err.code, err.message).errorMessage;
}

function toOctokitError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const e = err as { status?: number; message?: string };
  if (e.status === 401)
    return new ConnectorError(
      401,
      "REPO_AUTH_FAILED",
      `GitHub auth failed${e.message && e.message !== "HttpError" ? `: ${e.message}` : ""}`,
    );
  if (e.status === 403)
    return new ConnectorError(403, "REPO_FORBIDDEN", "GitHub forbidden / rate-limited");
  if (e.status === 404) return new ConnectorError(404, "REPO_NOT_FOUND", "GitHub repo not found");
  return new ConnectorError(502, "REPO_API_ERROR", e.message ?? "GitHub API error");
}

/** Test reset. */
export function __resetRepoConnectorService(): void {
  depsRef = {};
}

// Suppress unused-import warning when `log` isn't otherwise referenced at runtime.
void log;
