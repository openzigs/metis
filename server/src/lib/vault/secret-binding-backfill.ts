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
 * by label). A reference that is ambiguous or reaches nothing is FLAGGED, never
 * guessed: it is audited as `vault.binding_backfill_flagged`, and the row is
 * written so that the reference can no longer resolve by label —
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
import { createChildLogger } from "../logger.js";
import { refBodiesIn, refBodyOf } from "./secret-binding.js";
import {
  bindSecretRefs,
  VAULT_REF_AMBIGUOUS,
  VAULT_REF_UNRESOLVED,
  type SecretBindings,
} from "./bound-secret.js";

const log = createChildLogger("vault-binding-backfill");

export const BACKFILL_FLAGGED_ACTION = "vault.binding_backfill_flagged";

export type BindingFlagReason = "ambiguous" | "unresolved";

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

function flagAudit(type: string, id: string, flagged: FlaggedRef[]): void {
  log.warn("Vault reference could not be bound; it will not resolve until re-saved", {
    type,
    id,
    flagged,
  });
  audit({
    actor: null,
    action: BACKFILL_FLAGGED_ACTION,
    target: { type, id },
    metadata: { flagged },
  });
}

async function backfillMcpServers(report: SecretBindingBackfillReport): Promise<void> {
  const rows = await prisma.mCPServer.findMany({
    where: { secretBindings: null },
    select: { id: true, envJson: true, headers: true },
  });
  for (const row of rows) {
    const refs = [
      ...new Set([...refBodiesIn(parseMap(row.envJson)), ...refBodiesIn(parseMap(row.headers))]),
    ];
    const bindings: SecretBindings = Object.create(null) as SecretBindings;
    const flagged: FlaggedRef[] = [];
    for (const ref of refs) {
      const r = await bindOne(ref);
      if ("id" in r) bindings[ref] = r.id;
      else flagged.push({ ref, reason: r.flag });
    }
    const { count } = await prisma.mCPServer.updateMany({
      where: { id: row.id, secretBindings: null },
      data: { secretBindings: JSON.stringify(bindings) },
    });
    if (count === 0) continue; // saved (and so bound) since we read it
    if (flagged.length > 0) {
      report.mcpServersFlagged += 1;
      flagAudit("mcp_server", row.id, flagged);
    } else {
      report.mcpServersBound += 1;
    }
  }
}

async function backfillPublishBatches(report: SecretBindingBackfillReport): Promise<void> {
  const rows = await prisma.publishBatch.findMany({
    where: { dryRun: false, archived: false, metadata: { contains: "secretRef" } },
    select: { id: true, metadata: true },
  });
  for (const row of rows) {
    const meta = parseMap(row.metadata);
    if (!meta || Object.hasOwn(meta, "secretId")) continue;
    const ref = refBodyOf(typeof meta.secretRef === "string" ? meta.secretRef : null);
    if (!ref) continue;
    const r = await bindOne(ref);
    const next =
      "id" in r
        ? { ...meta, secretId: r.id }
        : { ...meta, secretId: null, secretBindingFlag: r.flag };
    const { count } = await prisma.publishBatch.updateMany({
      where: { id: row.id, metadata: row.metadata },
      data: { metadata: JSON.stringify(next) },
    });
    if (count === 0) continue;
    if ("id" in r) {
      report.batchesBound += 1;
    } else {
      report.batchesFlagged += 1;
      flagAudit("publish_batch", row.id, [{ ref, reason: r.flag }]);
    }
  }
}

/** Bind every pre-#480 MCP server and live publish batch; flag what cannot be bound. */
export async function backfillSecretBindings(): Promise<SecretBindingBackfillReport> {
  const report: SecretBindingBackfillReport = {
    mcpServersBound: 0,
    mcpServersFlagged: 0,
    batchesBound: 0,
    batchesFlagged: 0,
  };
  await backfillMcpServers(report);
  await backfillPublishBatches(report);
  if (Object.values(report).some((n) => n > 0)) {
    log.info("Pre-#480 vault references backfilled", { ...report });
  }
  return report;
}
