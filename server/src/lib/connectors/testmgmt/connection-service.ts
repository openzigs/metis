/**
 * Test management connector service — Epic #856 / Issue #871.
 *
 * CRUD + connectivity test for `TestManagementConnection` rows that drive the
 * Xray / Zephyr / TestRail exporters in `lib/testcoverage/exporters/`. Secrets
 * are stored in the vault and referenced from `authConfigJson` /
 * `tlsConfigJson` as `${vault:label-or-id}` tokens — plaintext never persists
 * on the row and is never logged.
 *
 * Every code path that touches the network calls `assertConnectorHostAllowed`
 * against the configured `baseUrl` so a stored connection cannot be coerced
 * into reaching an internal IP after it was created.
 */
import type {
  CreateTestManagementConnectionInput,
  UpdateTestManagementConnectionInput,
  TestManagementConnectionDetail,
  TestManagementKind,
  TestManagementStatus,
  TestManagementTestResult,
} from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../prisma.js";
import { getVaultService, type VaultService } from "../../vault/vault-service.js";
import { audit } from "../../audit/audit-service.js";
import { createChildLogger } from "../../logger.js";
import { ConnectorError } from "../types.js";
import { assertConnectorHostAllowed, type ConnectorKind } from "../network-allowlist.js";
import { asVaultRef, resolveVaultRef } from "../vault-resolver.js";
import { authenticateXray, buildBasicAuthHeader, buildBearerHeader } from "./auth.js";
import type {
  PersistedProxyConfig,
  PersistedTlsConfig,
  ResolvedAuthConfig,
  ResolvedTlsConfig,
  TestManagementAuthConfigRefs,
} from "./types.js";

const log = createChildLogger("testmgmt-service");

type TestManagementRow = NonNullable<
  Awaited<ReturnType<typeof defaultPrisma.testManagementConnection.findFirst>>
>;

type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface TestManagementServiceDeps {
  prisma?: Pick<PrismaClient, "testManagementConnection">;
  vault?: VaultService;
  /** Connectivity-test fetcher (defaults to global fetch). */
  fetchFn?: FetchLike;
  /** SSRF guard — defaults to network-allowlist's `assertConnectorHostAllowed`. */
  assertHost?: (hostname: string, kind: ConnectorKind) => Promise<void>;
}

function pickPrisma(deps?: TestManagementServiceDeps): TestManagementServiceDeps["prisma"] {
  return (deps?.prisma ?? defaultPrisma) as TestManagementServiceDeps["prisma"];
}
function pickVault(deps?: TestManagementServiceDeps): VaultService {
  return deps?.vault ?? getVaultService();
}
function pickFetch(deps?: TestManagementServiceDeps): FetchLike {
  return deps?.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
}
function pickAssertHost(
  deps?: TestManagementServiceDeps,
): (host: string, kind: ConnectorKind) => Promise<void> {
  return deps?.assertHost ?? assertConnectorHostAllowed;
}

// ---- Small helpers --------------------------------------------------------

function sanitizeLabelComponent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isValidKind(k: string): k is TestManagementKind {
  return k === "xray" || k === "zephyr" || k === "testrail";
}

function publicAuthConfig(row: TestManagementRow): Record<string, string> {
  const raw = parseJsonOr<Record<string, unknown>>(row.authConfigJson, {});
  const out: Record<string, string> = {};
  // Expose vault refs (already not plaintext) and the testrail email (not a secret).
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function toApi(row: TestManagementRow): TestManagementConnectionDetail {
  const tls = parseJsonOr<PersistedTlsConfig | null>(row.tlsConfigJson, null);
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    kind: row.kind as TestManagementKind,
    baseUrl: row.baseUrl,
    authConfig: publicAuthConfig(row),
    proxyConfig: parseJsonOr<PersistedProxyConfig | null>(row.proxyConfigJson, null),
    tlsConfig: tls
      ? {
          rejectUnauthorized: tls.rejectUnauthorized ?? true,
          hasCaCert: Boolean(tls.caCertRef),
        }
      : null,
    status: row.status as TestManagementStatus,
    errorMessage: row.errorMessage,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findOrThrow(
  db: NonNullable<TestManagementServiceDeps["prisma"]>,
  id: string,
  projectId?: string,
): Promise<TestManagementRow> {
  const where: Record<string, unknown> = { id, deletedAt: null };
  if (projectId) where.projectId = projectId;
  const row = await db.testManagementConnection.findFirst({ where });
  if (!row) {
    throw new ConnectorError(404, "TESTMGMT_NOT_FOUND", "test management connection not found");
  }
  return row;
}

// ---- Auth-config persistence (raw → vault refs) ---------------------------

async function persistAuthConfig(
  vault: VaultService,
  projectId: string,
  label: string,
  input: CreateTestManagementConnectionInput["auth"],
): Promise<TestManagementAuthConfigRefs> {
  const base = sanitizeLabelComponent(`testmgmt-${projectId}-${label}`);
  switch (input.kind) {
    case "xray": {
      const cid = await vault.create(`${base}-client-id`, input.clientId, "project", {
        description: `Xray client_id for ${label}`,
      });
      const csec = await vault.create(`${base}-client-secret`, input.clientSecret, "project", {
        description: `Xray client_secret for ${label}`,
      });
      return {
        kind: "xray",
        clientIdRef: asVaultRef(cid.id),
        clientSecretRef: asVaultRef(csec.id),
      };
    }
    case "zephyr": {
      const t = await vault.create(`${base}-bearer`, input.bearerToken, "project", {
        description: `Zephyr bearer token for ${label}`,
      });
      return { kind: "zephyr", bearerTokenRef: asVaultRef(t.id) };
    }
    case "testrail": {
      const k = await vault.create(`${base}-api-key`, input.apiKey, "project", {
        description: `TestRail API key for ${label}`,
      });
      return { kind: "testrail", email: input.email, apiKeyRef: asVaultRef(k.id) };
    }
  }
}

async function persistTlsConfig(
  vault: VaultService,
  projectId: string,
  label: string,
  input: NonNullable<CreateTestManagementConnectionInput["tlsConfig"]>,
): Promise<PersistedTlsConfig | null> {
  if (!input) return null;
  let caCertRef: string | null = null;
  if (input.caCert) {
    const base = sanitizeLabelComponent(`testmgmt-${projectId}-${label}-ca`);
    const s = await vault.create(base, input.caCert, "project", {
      description: `TLS CA cert for ${label}`,
    });
    caCertRef = asVaultRef(s.id);
  }
  return {
    rejectUnauthorized: input.rejectUnauthorized ?? true,
    caCertRef,
  };
}

// ---- Vault → resolved plaintext (in-process only) -------------------------

async function resolveAuthConfig(
  vault: VaultService,
  refs: TestManagementAuthConfigRefs,
): Promise<ResolvedAuthConfig> {
  switch (refs.kind) {
    case "xray": {
      const clientId = await resolveVaultRef(refs.clientIdRef, vault);
      const clientSecret = await resolveVaultRef(refs.clientSecretRef, vault);
      if (!clientId || !clientSecret) {
        throw new ConnectorError(
          500,
          "TESTMGMT_AUTH_UNRESOLVED",
          "xray credentials could not be resolved from vault",
        );
      }
      return { kind: "xray", clientId, clientSecret };
    }
    case "zephyr": {
      const bearerToken = await resolveVaultRef(refs.bearerTokenRef, vault);
      if (!bearerToken) {
        throw new ConnectorError(
          500,
          "TESTMGMT_AUTH_UNRESOLVED",
          "zephyr bearer token could not be resolved from vault",
        );
      }
      return { kind: "zephyr", bearerToken };
    }
    case "testrail": {
      const apiKey = await resolveVaultRef(refs.apiKeyRef, vault);
      if (!apiKey) {
        throw new ConnectorError(
          500,
          "TESTMGMT_AUTH_UNRESOLVED",
          "testrail api key could not be resolved from vault",
        );
      }
      return { kind: "testrail", email: refs.email, apiKey };
    }
  }
}

async function resolveTlsConfig(
  vault: VaultService,
  tls: PersistedTlsConfig | null,
): Promise<ResolvedTlsConfig | null> {
  if (!tls) return null;
  let caCert: string | null = null;
  if (tls.caCertRef) {
    caCert = await resolveVaultRef(tls.caCertRef, vault);
  }
  return {
    rejectUnauthorized: tls.rejectUnauthorized ?? true,
    caCert,
  };
}

// ---- CRUD -----------------------------------------------------------------

export async function listTestManagementConnections(
  projectId: string,
  deps?: TestManagementServiceDeps,
): Promise<TestManagementConnectionDetail[]> {
  const db = pickPrisma(deps)!;
  const rows = await db.testManagementConnection.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toApi);
}

export async function getTestManagementConnection(
  id: string,
  projectId?: string,
  deps?: TestManagementServiceDeps,
): Promise<TestManagementConnectionDetail> {
  const db = pickPrisma(deps)!;
  return toApi(await findOrThrow(db, id, projectId));
}

export async function createTestManagementConnection(
  projectId: string,
  input: CreateTestManagementConnectionInput,
  actorId: string,
  deps?: TestManagementServiceDeps,
): Promise<TestManagementConnectionDetail> {
  const db = pickPrisma(deps)!;
  const vault = pickVault(deps);
  const assertHost = pickAssertHost(deps);

  // SSRF guard at the boundary — refuse to even persist a row whose baseUrl
  // points at a forbidden host.
  const { hostname } = new URL(input.baseUrl);
  await assertHost(hostname, input.kind as ConnectorKind);

  if (input.kind !== input.auth.kind) {
    throw new ConnectorError(
      400,
      "TESTMGMT_KIND_MISMATCH",
      `auth.kind '${input.auth.kind}' does not match connection kind '${input.kind}'`,
    );
  }

  const existing = await db.testManagementConnection.findFirst({
    where: { projectId, label: input.label, deletedAt: null },
  });
  if (existing) {
    throw new ConnectorError(
      409,
      "TESTMGMT_LABEL_TAKEN",
      `label '${input.label}' already exists in this project`,
    );
  }

  log.info("Creating test management connection", {
    projectId,
    label: input.label,
    kind: input.kind,
  });

  const refs = await persistAuthConfig(vault, projectId, input.label, input.auth);
  const tls = input.tlsConfig
    ? await persistTlsConfig(vault, projectId, input.label, input.tlsConfig)
    : null;

  const row = await db.testManagementConnection.create({
    data: {
      projectId,
      label: input.label,
      kind: input.kind,
      baseUrl: input.baseUrl,
      authConfigJson: JSON.stringify(refs),
      proxyConfigJson: input.proxyConfig ? JSON.stringify(input.proxyConfig) : null,
      tlsConfigJson: tls ? JSON.stringify(tls) : null,
      status: "untested",
      createdById: actorId,
    },
  });

  audit({
    actor: { id: actorId },
    action: "connector.testmgmt.create",
    target: { type: "test_management_connection", id: row.id },
    metadata: { projectId, kind: input.kind, baseUrl: input.baseUrl },
  });

  return toApi(row);
}

export async function updateTestManagementConnection(
  id: string,
  input: UpdateTestManagementConnectionInput,
  actorId: string,
  projectId?: string,
  deps?: TestManagementServiceDeps,
): Promise<TestManagementConnectionDetail> {
  const db = pickPrisma(deps)!;
  const vault = pickVault(deps);
  const assertHost = pickAssertHost(deps);
  const existing = await findOrThrow(db, id, projectId);

  const data: Record<string, unknown> = {};
  let baseUrlChanged = false;
  let authChanged = false;

  if (input.baseUrl !== undefined && input.baseUrl !== existing.baseUrl) {
    const { hostname } = new URL(input.baseUrl);
    await assertHost(hostname, existing.kind as ConnectorKind);
    data.baseUrl = input.baseUrl;
    baseUrlChanged = true;
  }
  if (input.label !== undefined && input.label !== existing.label) {
    const dup = await db.testManagementConnection.findFirst({
      where: {
        projectId: existing.projectId,
        label: input.label,
        deletedAt: null,
        NOT: { id: existing.id },
      },
    });
    if (dup) {
      throw new ConnectorError(
        409,
        "TESTMGMT_LABEL_TAKEN",
        `label '${input.label}' already exists in this project`,
      );
    }
    data.label = input.label;
  }

  if (input.auth) {
    if (input.auth.kind !== existing.kind) {
      throw new ConnectorError(
        400,
        "TESTMGMT_KIND_MISMATCH",
        `cannot change connection kind from '${existing.kind}' to '${input.auth.kind}'`,
      );
    }
    const refs = await persistAuthConfig(
      vault,
      existing.projectId,
      (data.label as string | undefined) ?? existing.label,
      input.auth,
    );
    data.authConfigJson = JSON.stringify(refs);
    authChanged = true;
  }

  if (input.proxyConfig !== undefined) {
    data.proxyConfigJson = input.proxyConfig ? JSON.stringify(input.proxyConfig) : null;
  }

  if (input.tlsConfig !== undefined) {
    if (input.tlsConfig === null) {
      data.tlsConfigJson = null;
    } else {
      const tls = await persistTlsConfig(
        vault,
        existing.projectId,
        (data.label as string | undefined) ?? existing.label,
        input.tlsConfig,
      );
      data.tlsConfigJson = tls ? JSON.stringify(tls) : null;
    }
  }

  // Any connection-shape change invalidates a previous "ok" status.
  if (baseUrlChanged || authChanged) {
    data.status = "untested";
    data.errorMessage = null;
  }

  const row = await db.testManagementConnection.update({ where: { id }, data });

  audit({
    actor: { id: actorId },
    action: "connector.testmgmt.update",
    target: { type: "test_management_connection", id },
    metadata: {
      projectId: existing.projectId,
      kind: existing.kind,
      fields: Object.keys(data),
    },
  });

  return toApi(row);
}

export async function deleteTestManagementConnection(
  id: string,
  actorId: string,
  projectId?: string,
  deps?: TestManagementServiceDeps,
): Promise<void> {
  const db = pickPrisma(deps)!;
  const existing = await findOrThrow(db, id, projectId);
  await db.testManagementConnection.update({
    where: { id },
    data: { deletedAt: new Date(), status: "untested" },
  });
  audit({
    actor: { id: actorId },
    action: "connector.testmgmt.delete",
    target: { type: "test_management_connection", id },
    metadata: { projectId: existing.projectId, kind: existing.kind },
  });
}

// ---- Connectivity test ----------------------------------------------------

/**
 * Run a minimal authenticated GET (or POST for Xray's JWT exchange) to verify
 * the connection works end-to-end. Re-asserts the SSRF host policy every time
 * so a TOCTOU between create and test cannot bypass the allow-list.
 */
export async function testTestManagementConnection(
  id: string,
  actorId: string,
  projectId?: string,
  deps?: TestManagementServiceDeps,
): Promise<TestManagementTestResult> {
  const db = pickPrisma(deps)!;
  const vault = pickVault(deps);
  const fetchFn = pickFetch(deps);
  const assertHost = pickAssertHost(deps);
  const row = await findOrThrow(db, id, projectId);

  if (!isValidKind(row.kind)) {
    throw new ConnectorError(
      500,
      "TESTMGMT_KIND_INVALID",
      `stored connection has unknown kind '${row.kind}'`,
    );
  }

  // Re-validate at test time — defence-in-depth against rebinding / mutation
  // of the row by some other code path.
  const { hostname } = new URL(row.baseUrl);
  await assertHost(hostname, row.kind as ConnectorKind);

  const refs = parseJsonOr<TestManagementAuthConfigRefs | null>(row.authConfigJson, null);
  if (!refs || refs.kind !== row.kind) {
    throw new ConnectorError(
      500,
      "TESTMGMT_AUTH_MALFORMED",
      "stored auth config does not match connection kind",
    );
  }
  const auth = await resolveAuthConfig(vault, refs);

  // tlsConfig is resolved so callers verify the CA decrypts cleanly; we don't
  // actually wire it into fetch's agent here — the per-kind exporters do that.
  await resolveTlsConfig(vault, parseJsonOr<PersistedTlsConfig | null>(row.tlsConfigJson, null));

  const start = Date.now();
  try {
    if (auth.kind === "xray") {
      await authenticateXray(row.baseUrl, auth.clientId, auth.clientSecret, fetchFn);
    } else if (auth.kind === "zephyr") {
      const res = await fetchFn(`${row.baseUrl.replace(/\/+$/, "")}/healthcheck`, {
        method: "GET",
        headers: {
          Authorization: buildBearerHeader(auth.bearerToken),
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        throw new ConnectorError(
          502,
          "TESTMGMT_ZEPHYR_TEST_FAILED",
          `Zephyr health check failed (HTTP ${res.status})`,
        );
      }
    } else {
      const url = `${row.baseUrl.replace(/\/+$/, "")}/index.php?/api/v2/get_priorities`;
      const res = await fetchFn(url, {
        method: "GET",
        headers: {
          Authorization: buildBasicAuthHeader(auth.email, auth.apiKey),
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        throw new ConnectorError(
          502,
          "TESTMGMT_TESTRAIL_TEST_FAILED",
          `TestRail check failed (HTTP ${res.status})`,
        );
      }
    }
    const latencyMs = Date.now() - start;
    await db.testManagementConnection.update({
      where: { id },
      data: { status: "ok", errorMessage: null, lastTestedAt: new Date() },
    });
    audit({
      actor: { id: actorId },
      action: "connector.testmgmt.test",
      target: { type: "test_management_connection", id },
      metadata: {
        projectId: row.projectId,
        kind: row.kind,
        status: "ok",
        latencyMs,
      },
    });
    return { ok: true, latencyMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const latencyMs = Date.now() - start;
    await db.testManagementConnection.update({
      where: { id },
      data: { status: "error", errorMessage: message, lastTestedAt: new Date() },
    });
    audit({
      actor: { id: actorId },
      action: "connector.testmgmt.test",
      target: { type: "test_management_connection", id },
      metadata: {
        projectId: row.projectId,
        kind: row.kind,
        status: "error",
        errorMessage: message,
      },
    });
    return { ok: false, latencyMs, errorMessage: message };
  }
}

// ---- Resolved-connection helper (for downstream exporters) ----------------

/**
 * Load a connection and resolve its auth + TLS secrets from the vault. The
 * returned object contains plaintext credentials and MUST be discarded
 * immediately after use; never log it.
 */
export async function loadResolvedTestManagementConnection(
  id: string,
  projectId?: string,
  deps?: TestManagementServiceDeps,
): Promise<{
  id: string;
  projectId: string;
  label: string;
  kind: TestManagementKind;
  baseUrl: string;
  auth: ResolvedAuthConfig;
  tls: ResolvedTlsConfig | null;
  proxy: PersistedProxyConfig | null;
}> {
  const db = pickPrisma(deps)!;
  const vault = pickVault(deps);
  const assertHost = pickAssertHost(deps);
  const row = await findOrThrow(db, id, projectId);
  if (!isValidKind(row.kind)) {
    throw new ConnectorError(
      500,
      "TESTMGMT_KIND_INVALID",
      `stored connection has unknown kind '${row.kind}'`,
    );
  }
  const { hostname } = new URL(row.baseUrl);
  await assertHost(hostname, row.kind as ConnectorKind);
  const refs = parseJsonOr<TestManagementAuthConfigRefs | null>(row.authConfigJson, null);
  if (!refs || refs.kind !== row.kind) {
    throw new ConnectorError(
      500,
      "TESTMGMT_AUTH_MALFORMED",
      "stored auth config does not match connection kind",
    );
  }
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    kind: row.kind as TestManagementKind,
    baseUrl: row.baseUrl,
    auth: await resolveAuthConfig(vault, refs),
    tls: await resolveTlsConfig(
      vault,
      parseJsonOr<PersistedTlsConfig | null>(row.tlsConfigJson, null),
    ),
    proxy: parseJsonOr<PersistedProxyConfig | null>(row.proxyConfigJson, null),
  };
}
