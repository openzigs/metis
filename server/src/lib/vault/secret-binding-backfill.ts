/**
 * #504 — bind the vault references saved before #480.
 *
 * #480 stores the secret id each `${vault:x}` reference resolved to when a
 * resource was saved, and reads only that id afterwards. Rows saved before it
 * carry no binding, so they kept resolving the label at use time — the re-bind
 * #480 closes (delete the secret, re-create the label elsewhere, and the
 * resource silently starts sending the new one):
 *
 *   - MCP servers with `secretBindings` NULL;
 *   - live (non-dry-run) publish batches whose `metadata` has a `secretRef` but
 *     no `secretId` key.
 *
 * This binds each such reference with the #344 matching rule (`bindSecretRefs`:
 * an id match wins, otherwise the reference must reach exactly one live secret
 * by label) AND the #344 ownership rule: the resource's owner (an MCP server's
 * `createdById`, a batch's `startedById`) must have created every secret the
 * reference can reach, unless they hold `vault.reveal` now. As in #358, a batch
 * is held to that only when its `targetBaseUrl` is caller-chosen
 * (`isCallerChosenPublishHost`); the public GitHub API is exempt. An MCP server
 * is judged against its CREATOR, where #344 judges whoever saved it — a
 * reference a later editor attached may be flagged, and re-saving the server
 * repairs it. Rows saved before
 * #344 were never checked, and binding a foreign secret here would send its
 * plaintext to a destination the owner chose (an MCP header, since #504, goes
 * to the server's URL). A reference that is ambiguous, reaches nothing, or is
 * not the owner's is FLAGGED, never guessed or bound: it is audited as
 * `vault.binding_backfill_flagged`, and the row is written so that the
 * reference can no longer resolve by label —
 *
 *   - an MCP server gets the bindings that did resolve; the flagged reference
 *     is left out, so `expandVaultRefs` refuses it ("save the server again");
 *   - a batch gets `secretId: null` and `secretBindingFlag: <reason>`, which
 *     `batchTokenSource` turns into "no token" (fail closed).
 *
 * Idempotent: only rows still lacking a binding are read, and each write is
 * conditional on the row being unchanged, so a second run — or a second replica
 * racing the first — writes nothing and audits nothing. It runs once per boot
 * on the cluster leader (`SingletonJobs`).
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { hasPermission } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { resolveEffectiveRoleFromRows } from "../auth/durable-roles.js";
import { refBodiesIn, refBodyOf, refsOwnedBy } from "./secret-binding.js";
import { isCallerChosenPublishHost } from "../publishing/publish-secret-binding.js";
import {
  bindSecretRefs,
  VAULT_REF_AMBIGUOUS,
  VAULT_REF_UNRESOLVED,
  type SecretBindings,
} from "./bound-secret.js";

const log = createChildLogger("vault-binding-backfill");

export const BACKFILL_FLAGGED_ACTION = "vault.binding_backfill_flagged";

export type BindingFlagReason = "ambiguous" | "unresolved" | "not_owned";

export interface FlaggedRef {
  ref: string;
  reason: BindingFlagReason;
}

export interface SecretBindingBackfillReport {
  mcpServersBound: number;
  mcpServersFlagged: number;
  batchesBound: number;
  batchesFlagged: number;
}

/** Bind one reference, or say why it cannot be bound. Other errors propagate. */
async function bindOne(ref: string): Promise<{ id: string } | { flag: BindingFlagReason }> {
  try {
    const bound = await bindSecretRefs([ref]);
    return { id: bound[ref] };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === VAULT_REF_AMBIGUOUS) return { flag: "ambiguous" };
    if (code === VAULT_REF_UNRESOLVED) return { flag: "unresolved" };
    throw err;
  }
}

/**
 * Could `userId` attach a secret they did not create? Only with `vault.reveal`
 * (#344), read from their CURRENT roles: an inactive or deleted owner, or none,
 * gets no exemption. Cached per run.
 */
async function mayBindForeign(
  userId: string | null,
  cache: Map<string, boolean>,
): Promise<boolean> {
  if (userId === null) return false;
  const hit = cache.get(userId);
  if (hit !== undefined) return hit;
  const user = await prisma.user.findFirst({
    where: { id: userId, status: "active", deletedAt: null },
    select: { authRoleAuthority: true, roles: { include: { role: true } } },
  });
  const ok = user
    ? hasPermission(
        resolveEffectiveRoleFromRows(user.roles, user.authRoleAuthority).role,
        "vault.reveal",
      )
    : false;
  cache.set(userId, ok);
  return ok;
}

/**
 * Bind every reference with {@link bindOne}, then — when `enforceOwnership` —
 * drop as `not_owned` any the owner could not have attached at save time under
 * #344.
 */
async function bindForOwner(
  refs: string[],
  ownerId: string | null,
  cache: Map<string, boolean>,
  enforceOwnership = true,
): Promise<{ bindings: SecretBindings; flagged: FlaggedRef[] }> {
  const bindings: SecretBindings = Object.create(null) as SecretBindings;
  const flagged: FlaggedRef[] = [];
  for (const ref of refs) {
    const r = await bindOne(ref);
    if ("id" in r) bindings[ref] = r.id;
    else flagged.push({ ref, reason: r.flag });
  }
  const bound = Object.keys(bindings);
  if (enforceOwnership && bound.length > 0 && !(await mayBindForeign(ownerId, cache))) {
    const owned = await refsOwnedBy(ownerId, bound);
    for (const ref of bound) {
      if (owned.has(ref)) continue;
      delete bindings[ref];
      flagged.push({ ref, reason: "not_owned" });
    }
  }
  return { bindings, flagged };
}

function parseMap(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function flagAudit(
  type: string,
  id: string,
  flagged: FlaggedRef[],
  extra: Record<string, unknown> = {},
): void {
  log.warn("Vault reference could not be bound; it will not resolve until re-saved", {
    type,
    id,
    flagged,
    ...extra,
  });
  audit({
    actor: null,
    action: BACKFILL_FLAGGED_ACTION,
    target: { type, id },
    metadata: { flagged, ...extra },
  });
}

/**
 * One row's unexpected error (a vault or database fault — not a flag) is logged
 * and skipped, so it cannot stop the rows after it. The row stays unbound, is
 * retried on the next boot, and until then a header reference in it is refused
 * at connect time rather than resolved by label.
 */
function rowFailed(type: string, id: string, err: unknown): void {
  log.warn("Vault binding backfill failed for a row; continuing with the rest", {
    type,
    id,
    error: err instanceof Error ? err.message : String(err),
  });
}

async function backfillMcpServers(
  report: SecretBindingBackfillReport,
  cache: Map<string, boolean>,
): Promise<void> {
  // A soft-deleted server never connects again; leave it unbound and unflagged.
  const rows = await prisma.mCPServer.findMany({
    where: { secretBindings: null, deletedAt: null },
    select: { id: true, label: true, envJson: true, headers: true, createdById: true },
  });
  for (const row of rows) {
    try {
      await backfillMcpServer(row, report, cache);
    } catch (err) {
      rowFailed("mcp_server", row.id, err);
    }
  }
}

async function backfillMcpServer(
  row: {
    id: string;
    label: string;
    envJson: string | null;
    headers: string | null;
    createdById: string | null;
  },
  report: SecretBindingBackfillReport,
  cache: Map<string, boolean>,
): Promise<void> {
  const refs = [
    ...new Set([...refBodiesIn(parseMap(row.envJson)), ...refBodiesIn(parseMap(row.headers))]),
  ];
  const { bindings, flagged } = await bindForOwner(refs, row.createdById, cache);
  const { count } = await prisma.mCPServer.updateMany({
    where: { id: row.id, secretBindings: null },
    data: { secretBindings: JSON.stringify(bindings) },
  });
  if (count === 0) return; // saved (and so bound) since we read it
  if (flagged.length > 0) {
    report.mcpServersFlagged += 1;
    // Enough to act on without a join: which server, which refs, whose
    // ownership was judged (the creator, not a later editor), and the repair.
    flagAudit("mcp_server", row.id, flagged, {
      serverId: row.id,
      serverLabel: row.label,
      judgedOwnerId: row.createdById,
      remedy: "Save the MCP server again to re-bind its vault references.",
    });
  } else {
    report.mcpServersBound += 1;
  }
}

async function backfillPublishBatches(
  report: SecretBindingBackfillReport,
  cache: Map<string, boolean>,
): Promise<void> {
  const rows = await prisma.publishBatch.findMany({
    where: { dryRun: false, archived: false, metadata: { contains: "secretRef" } },
    select: { id: true, metadata: true, startedById: true, targetBaseUrl: true },
  });
  for (const row of rows) {
    try {
      await backfillPublishBatch(row, report, cache);
    } catch (err) {
      rowFailed("publish_batch", row.id, err);
    }
  }
}

async function backfillPublishBatch(
  row: {
    id: string;
    metadata: string | null;
    startedById: string | null;
    targetBaseUrl: string | null;
  },
  report: SecretBindingBackfillReport,
  cache: Map<string, boolean>,
): Promise<void> {
  const meta = parseMap(row.metadata);
  if (!meta || Object.hasOwn(meta, "secretId")) return;
  const ref = refBodyOf(typeof meta.secretRef === "string" ? meta.secretRef : null);
  if (!ref) return;
  // #358 enforces ownership only for a caller-chosen host: a token sent to the
  // public GitHub API goes to the service that issued it. Same predicate as
  // `assertPublishSecretBinding`, so the backfill and createBatch cannot drift.
  const { bindings, flagged } = await bindForOwner(
    [ref],
    row.startedById,
    cache,
    isCallerChosenPublishHost(row.targetBaseUrl),
  );
  const r: { id: string } | { flag: BindingFlagReason } =
    flagged.length > 0 ? { flag: flagged[0].reason } : { id: bindings[ref] };
  const next =
    "id" in r
      ? { ...meta, secretId: r.id }
      : { ...meta, secretId: null, secretBindingFlag: r.flag };
  const { count } = await prisma.publishBatch.updateMany({
    where: { id: row.id, metadata: row.metadata },
    data: { metadata: JSON.stringify(next) },
  });
  if (count === 0) return;
  if ("id" in r) {
    report.batchesBound += 1;
  } else {
    report.batchesFlagged += 1;
    flagAudit("publish_batch", row.id, [{ ref, reason: r.flag }]);
  }
}

/** Bind every pre-#480 live MCP server and live publish batch; flag what cannot be bound. */
export async function backfillSecretBindings(): Promise<SecretBindingBackfillReport> {
  const report: SecretBindingBackfillReport = {
    mcpServersBound: 0,
    mcpServersFlagged: 0,
    batchesBound: 0,
    batchesFlagged: 0,
  };
  const mayReveal = new Map<string, boolean>();
  await backfillMcpServers(report, mayReveal);
  await backfillPublishBatches(report, mayReveal);
  if (Object.values(report).some((n) => n > 0)) {
    log.info("Pre-#480 vault references backfilled", { ...report });
  }
  return report;
}
