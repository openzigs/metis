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
import { rotateOrCreate } from "../../vault/secret-rotation.js";
import { retireReplacedSecret } from "../../vault/secret-retirement.js";
import { audit } from "../../audit/audit-service.js";
import { createChildLogger } from "../../logger.js";
import { ConnectorError, concurrentUpdateError, rowUnchangedSince } from "../types.js";
import { assertConnectorHostAllowed, type ConnectorKind } from "../network-allowlist.js";
import { asVaultRef, VAULT_BINDING_STALE } from "../vault-resolver.js";
import { authenticateXray, buildBasicAuthHeader, buildBearerHeader } from "./auth.js";
import type {
  PersistedProxyConfig,
  PersistedTlsConfig,
  ResolvedAuthConfig,
  ResolvedTlsConfig,
  TestManagementAuthConfigRefs,
} from "./types.js";
import { isUniqueViolation } from "../../db/prisma-errors.js";

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
  /** #481 — retires a replaced secret; defaults to `retireReplacedSecret`. */
  retireSecret?: typeof retireReplacedSecret;
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

/**
 * #481 — secret ids the update stopped referencing because a DIFFERENT secret
 * now holds the same credential (a non-owner's write got a fresh one, #358).
 * A credential cleared rather than replaced is not reported.
 */
function supersededSecretIds(
  before: Partial<Record<string, unknown>>,
  after: Partial<Record<string, unknown>>,
): string[] {
  const out: string[] = [];
  for (const [field, ref] of Object.entries(before)) {
    const oldId = typeof ref === "string" ? refId(ref) : null;
    const next = after[field];
    const newId = typeof next === "string" ? refId(next) : null;
    if (oldId && newId && oldId !== newId) out.push(oldId);
  }
  return out;
}

/**
 * #495 — the secret ids `after` holds that `before` did not: the ones a write
 * created rather than rotated in place.
 */
function createdSecretIds(
  before: Partial<Record<string, unknown>>,
  after: Partial<Record<string, unknown>>,
): string[] {
  const held = new Set(
    Object.values(before).map((ref) => (typeof ref === "string" ? refId(ref) : null)),
  );
  const out: string[] = [];
  for (const ref of Object.values(after)) {
    const newId = typeof ref === "string" ? refId(ref) : null;
    if (newId && !held.has(newId)) out.push(newId);
  }
  return out;
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

/** The secret id inside a stored `${vault:<id>}` ref, or null. */
function refId(ref: string | null | undefined): string | null {
  const m = ref ? /^\$\{vault:([^}]+)\}$/.exec(ref) : null;
  return m ? m[1] : null;
}

/**
 * #258 — write one credential. On update, `existingRef` is the connection's own
 * ref for the same field: its secret is rotated in place if this writer owns it
 * (see below). With no live secret
 * behind it (new connection, or the secret was deleted) a new secret is created
 * under a collision-free label. Re-creating under the derived name hit
 * `Secret.name @unique` — held by the connection's own secret, or by a
 * soft-deleted one — and 500'd.
 */
async function writeSecret(
  vault: VaultService,
  existingRef: string | null | undefined,
  value: string,
  label: string,
  description: string,
  createdById: string,
): Promise<string> {
  // #344/#358 — `rotateOrCreate` rewrites the existing secret in place only
  // when `createdById` (this writer) already owns it. A secret someone else
  // supplied — another user's, or a pre-#358 system-owned one — is left
  // untouched and a fresh secret owned by this writer is created instead, so
  // `createdById` always names whoever supplied the current credential. The
  // PATCH binding check (`assertTestMgmtSecretBinding`) depends on that.
  const { id } = await rotateOrCreate(vault, refId(existingRef), value, {
    label: sanitizeLabelComponent(label),
    scope: "project",
    description,
    createdById,
  });
  return asVaultRef(id);
}

async function persistAuthConfig(
  vault: VaultService,
  projectId: string,
  label: string,
  input: CreateTestManagementConnectionInput["auth"],
  actorId: string,
  existing: Partial<Record<string, string>> = {},
): Promise<TestManagementAuthConfigRefs> {
  const base = `testmgmt-${projectId}-${label}`;
  switch (input.kind) {
    case "xray": {
      const clientIdRef = await writeSecret(
        vault,
        existing.clientIdRef,
        input.clientId,
        `${base}-client-id`,
        `Xray client_id for ${label}`,
        actorId,
      );
      const clientSecretRef = await writeSecret(
        vault,
        existing.clientSecretRef,
        input.clientSecret,
        `${base}-client-secret`,
        `Xray client_secret for ${label}`,
        actorId,
      );
      return { kind: "xray", clientIdRef, clientSecretRef };
    }
    case "zephyr": {
      const bearerTokenRef = await writeSecret(
        vault,
        existing.bearerTokenRef,
        input.bearerToken,
        `${base}-bearer`,
        `Zephyr bearer token for ${label}`,
        actorId,
      );
      return { kind: "zephyr", bearerTokenRef };
    }
    case "testrail": {
      const apiKeyRef = await writeSecret(
        vault,
        existing.apiKeyRef,
        input.apiKey,
        `${base}-api-key`,
        `TestRail API key for ${label}`,
        actorId,
      );
      return { kind: "testrail", email: input.email, apiKeyRef };
    }
  }
}

async function persistTlsConfig(
  vault: VaultService,
  projectId: string,
  label: string,
  input: NonNullable<CreateTestManagementConnectionInput["tlsConfig"]>,
  actorId: string,
  existingCaCertRef: string | null = null,
): Promise<PersistedTlsConfig | null> {
  if (!input) return null;
  let caCertRef: string | null = null;
  if (input.caCert) {
    caCertRef = await writeSecret(
      vault,
      existingCaCertRef,
      input.caCert,
      `testmgmt-${projectId}-${label}-ca`,
      `TLS CA cert for ${label}`,
      actorId,
    );
  }
  return {
    rejectUnauthorized: input.rejectUnauthorized ?? true,
    caCertRef,
  };
}

function labelTaken(label: string): ConnectorError {
  return new ConnectorError(
    409,
    "TESTMGMT_LABEL_TAKEN",
    `label '${label}' already exists in this project`,
  );
}

/**
 * #258 — `@@unique([projectId, label])` also covers SOFT-DELETED connections,
 * so a deleted connection kept its label and re-using it 500'd on the index. A
 * deleted connection is never read by label, so its label moves to a tombstone
 * embedding its own id. Done at write time, so rows deleted earlier are freed too.
 */
async function releaseDeletedLabel(
  db: NonNullable<TestManagementServiceDeps["prisma"]>,
  projectId: string,
  label: string,
): Promise<void> {
  const holder = await db.testManagementConnection.findFirst({
    where: { projectId, label, deletedAt: { not: null } },
    select: { id: true },
  });
  if (!holder) return;
  await db.testManagementConnection.update({
    where: { id: holder.id },
    data: { label: `${label}~deleted-${holder.id}` },
  });
}

// ---- Vault → resolved plaintext (in-process only) -------------------------

/**
 * #504 — read a stored credential by the secret id its ref names, and nothing
 * else. Every ref this service writes is `${vault:<secret id>}` (`writeSecret`),
 * so the id IS the binding. `resolveVaultRef` would fall back to a label lookup
 * once that secret was deleted, picking up a secret someone created with a label
 * equal to the id; `vault.read` is by id and live rows only. This mirrors
 * `readBoundSecret` (#480) against the injected vault rather than the global
 * Prisma client.
 *
 * @throws ConnectorError 409 VAULT_BINDING_STALE when the bound secret is gone
 *   (`vault.read` reports `SECRET_NOT_FOUND`). Any other failure — a database
 *   outage, a decryption error — is rethrown unchanged: it says nothing about
 *   the binding, and "enter the credential again" would be the wrong advice.
 */
async function readBound(vault: VaultService, ref: string | null | undefined): Promise<string> {
  const id = refId(ref);
  if (!id) {
    throw new ConnectorError(
      500,
      "TESTMGMT_AUTH_UNRESOLVED",
      "stored credential reference is missing or malformed",
    );
  }
  try {
    const { plaintext } = await vault.read(id);
    return plaintext;
  } catch (err) {
    if ((err as { code?: unknown }).code !== "SECRET_NOT_FOUND") throw err;
    log.warn("Bound test-management secret not live", { secretId: id });
    throw new ConnectorError(
      409,
      VAULT_BINDING_STALE,
      "the vault secret this connection was bound to has been deleted; enter the credential again",
    );
  }
}

async function resolveAuthConfig(
  vault: VaultService,
  refs: TestManagementAuthConfigRefs,
): Promise<ResolvedAuthConfig> {
  switch (refs.kind) {
    case "xray":
      return {
        kind: "xray",
        clientId: await readBound(vault, refs.clientIdRef),
        clientSecret: await readBound(vault, refs.clientSecretRef),
      };
    case "zephyr":
      return { kind: "zephyr", bearerToken: await readBound(vault, refs.bearerTokenRef) };
    case "testrail":
      return {
        kind: "testrail",
        email: refs.email,
        apiKey: await readBound(vault, refs.apiKeyRef),
      };
  }
}

async function resolveTlsConfig(
  vault: VaultService,
  tls: PersistedTlsConfig | null,
): Promise<ResolvedTlsConfig | null> {
  if (!tls) return null;
  let caCert: string | null = null;
  if (tls.caCertRef) {
    caCert = await readBound(vault, tls.caCertRef);
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
  if (existing) throw labelTaken(input.label);
  await releaseDeletedLabel(db, projectId, input.label);

  log.info("Creating test management connection", {
    projectId,
    label: input.label,
    kind: input.kind,
  });

  const refs = await persistAuthConfig(vault, projectId, input.label, input.auth, actorId);
  const tls = input.tlsConfig
    ? await persistTlsConfig(vault, projectId, input.label, input.tlsConfig, actorId)
    : null;

  let row;
  try {
    row = await db.testManagementConnection.create({
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
  } catch (err) {
    // A concurrent create took the label after the check above: 409, and the
    // secrets just written belong to no connection, so they are withdrawn.
    if (!isUniqueViolation(err)) throw err;
    const written = [...Object.values(refs), tls?.caCertRef].map((r) =>
      typeof r === "string" ? refId(r) : null,
    );
    for (const id of written) if (id) await vault.delete(id).catch(() => undefined);
    throw labelTaken(input.label);
  }

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
  /** #479 — the `updatedAt` the binding guard read; the write is conditional on it. */
  expectedUpdatedAt?: Date | null,
): Promise<TestManagementConnectionDetail> {
  const db = pickPrisma(deps)!;
  const vault = pickVault(deps);
  const assertHost = pickAssertHost(deps);
  const existing = await findOrThrow(db, id, projectId);
  if (!rowUnchangedSince(existing.updatedAt, expectedUpdatedAt)) throw concurrentUpdateError();

  const data: Record<string, unknown> = {};
  let baseUrlChanged = false;
  let authChanged = false;
  const superseded: string[] = [];
  /** #495 — secrets this request created, withdrawn if the write does not land. */
  const created: string[] = [];

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
    if (dup) throw labelTaken(input.label);
    await releaseDeletedLabel(db, existing.projectId, input.label);
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
    const stored = parseJsonOr<Partial<Record<string, string>>>(existing.authConfigJson, {});
    const refs = await persistAuthConfig(
      vault,
      existing.projectId,
      (data.label as string | undefined) ?? existing.label,
      input.auth,
      actorId,
      stored,
    );
    data.authConfigJson = JSON.stringify(refs);
    authChanged = true;
    superseded.push(...supersededSecretIds(stored, { ...refs }));
    created.push(...createdSecretIds(stored, { ...refs }));
  }

  if (input.proxyConfig !== undefined) {
    data.proxyConfigJson = input.proxyConfig ? JSON.stringify(input.proxyConfig) : null;
  }

  if (input.tlsConfig !== undefined) {
    if (input.tlsConfig === null) {
      data.tlsConfigJson = null;
    } else {
      const oldCaCertRef =
        parseJsonOr<PersistedTlsConfig | null>(existing.tlsConfigJson, null)?.caCertRef ?? null;
      const tls = await persistTlsConfig(
        vault,
        existing.projectId,
        (data.label as string | undefined) ?? existing.label,
        input.tlsConfig,
        actorId,
        oldCaCertRef,
      );
      data.tlsConfigJson = tls ? JSON.stringify(tls) : null;
      superseded.push(
        ...supersededSecretIds({ caCertRef: oldCaCertRef }, { caCertRef: tls?.caCertRef }),
      );
      created.push(...createdSecretIds({ caCertRef: oldCaCertRef }, { caCertRef: tls?.caCertRef }));
    }
  }

  // Any connection-shape change invalidates a previous "ok" status.
  if (baseUrlChanged || authChanged) {
    data.status = "untested";
    data.errorMessage = null;
  }

  let row;
  try {
    if (expectedUpdatedAt === undefined) {
      row = await db.testManagementConnection.update({ where: { id }, data });
    } else {
      if (expectedUpdatedAt === null) throw concurrentUpdateError();
      const { count } = await db.testManagementConnection.updateMany({
        where: { id, updatedAt: expectedUpdatedAt },
        data,
      });
      if (count === 0) throw concurrentUpdateError();
      row = await db.testManagementConnection.findUniqueOrThrow({ where: { id } });
    }
  } catch (err) {
    // #495 — the secrets this request created belong to no connection now, so
    // they are withdrawn (as the create path does).
    for (const secretId of created) await vault.delete(secretId).catch(() => undefined);
    if (isUniqueViolation(err) && typeof data.label === "string") {
      throw labelTaken(data.label);
    }
    throw err;
  }

  // #481 — the row now points at the replacements; retire each old secret
  // unless something else still references it.
  const retire = deps?.retireSecret ?? retireReplacedSecret;
  for (const oldId of superseded) {
    await retire(vault, oldId, {
      actorId,
      target: { type: "test_management_connection", id },
      projectId: existing.projectId,
    });
  }

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
