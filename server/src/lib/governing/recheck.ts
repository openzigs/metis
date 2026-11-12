/**
 * #2222 — **Re-check this requirement**: run the governing check again on the
 * CURRENT wording of one stored requirement, and nothing else.
 *
 * An analysed requirement (`AC-2`) feeds several stored requirements and a
 * stored one draws on several analysed ones (`requirement-staleness.ts`), so a
 * stored requirement's new wording cannot stand in for an analysed one. The
 * re-check is therefore stored under the stored requirement's own id: its
 * applicability is decided afresh (screen and judge, as at the analysis's join),
 * its findings are produced from that, and both record the version judged
 * (`versions` on the applicability entry, `requirementVersions` on each row).
 * The analysed findings stay as they were, and stop being stale for this
 * requirement while it is at the version re-checked.
 *
 * ORDER. The findings are produced from the new entry in memory first, and the
 * entry is stored only once they are: an entry stored with no findings written
 * would clear the stale marker on the analysed findings with nothing in its
 * place. A requirement whose rules could not be loaded, or whose evaluation
 * failed, stores nothing and is reported as failed.
 *
 * CANCELLED (#2281). The route ties `signal` to the request: a client that goes
 * away aborts the model calls in flight, and a re-check aborted at any point
 * before its findings are written stores nothing (an aborted findings run
 * rejects before its write).
 *
 * TENANCY. The requirement is read with the analysis AND project ids, which the
 * route binds with `ensureAnalysisVisible`; the rules are the project's
 * workspace's (`governingApplicabilityHookFor`).
 */
import {
  parseAcceptanceCriteria,
  type GoverningRecheckResult,
  type GoverningRequirementApplicability,
} from "@metis/shared";
import type { AIProvider } from "../ai/types.js";
import { buildAuditLogData } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { governingApplicabilityHookFor } from "./applicability.js";
import {
  toStoredApplicability,
  upsertGoverningRequirementApplicability,
} from "./applicability-store.js";
import {
  produceGoverningFindingsForAnalysis,
  type GoverningFindingsRun,
} from "./findings-store.js";

const log = createChildLogger("governing-recheck");

export interface RecheckGoverningRequirementInput {
  analysisId: string;
  projectId: string;
  /** The stored requirement's id. */
  requirementId: string;
  provider: AIProvider;
  model?: string;
  signal?: AbortSignal;
  /** The session user, recorded on the audit row. */
  actorId: string;
  now?: Date;
}

export type RecheckGoverningRequirementOutcome =
  | { ok: true; result: GoverningRecheckResult }
  /** No live requirement with that id in this analysis of this project. */
  | { ok: false; reason: "not-found" }
  /** The flag is off, or the workspace has no current governing rule. */
  | { ok: false; reason: "no-rules" }
  /** The rules could not be read, or the requirement could not be evaluated. */
  | { ok: false; reason: "failed"; message: string }
  /** #2281 — `signal` aborted before anything was stored. */
  | { ok: false; reason: "cancelled" };

/** The wording a requirement is checked on: its title, body and acceptance criteria. */
export function requirementWording(r: {
  title: string;
  body: string;
  acceptanceCriteria: string | null;
}): string {
  const criteria = parseAcceptanceCriteria(r.acceptanceCriteria);
  const parts = [r.title.trim(), r.body.trim()].filter(Boolean);
  if (criteria.length > 0) {
    parts.push(["Acceptance criteria:", ...criteria.map((c) => `- ${c}`)].join("\n"));
  }
  return parts.join("\n\n");
}

export async function recheckGoverningRequirement(
  input: RecheckGoverningRequirementInput,
): Promise<RecheckGoverningRequirementOutcome> {
  const { analysisId, projectId } = input;
  const requirement = await prisma.requirement.findFirst({
    where: { id: input.requirementId, analysisId, projectId, deletedAt: null },
    select: { id: true, title: true, body: true, acceptanceCriteria: true, version: true },
  });
  if (!requirement) return { ok: false, reason: "not-found" };

  const hook = await governingApplicabilityHookFor({
    projectId,
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!hook) return { ok: false, reason: "no-rules" };

  const text = requirementWording(requirement);
  const set = await hook.decide({ id: requirement.id, text });
  if (input.signal?.aborted) return { ok: false, reason: "cancelled" };
  if (set.error) return { ok: false, reason: "failed", message: set.error };

  const at = input.now ?? new Date();
  const decided = toStoredApplicability(
    [{ requirementId: requirement.id, text, chunks: [], governing: set }],
    at,
  );
  const entry: GoverningRequirementApplicability = {
    ...decided.requirements[0]!,
    versions: { [requirement.id]: requirement.version },
  };
  let run: GoverningFindingsRun;
  try {
    run = await produceGoverningFindingsForAnalysis({
      analysisId,
      projectId,
      provider: input.provider,
      requirementIds: [requirement.id],
      applicability: { decidedAt: at.toISOString(), requirements: [entry] },
      ...(input.model ? { model: input.model } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (err) {
    // An aborted run rejects before it writes anything.
    if (input.signal?.aborted) return { ok: false, reason: "cancelled" };
    throw err;
  }
  if (run.failed > 0) {
    return {
      ok: false,
      reason: "failed",
      message: "The governing rules could not be checked against this requirement.",
    };
  }
  await upsertGoverningRequirementApplicability(analysisId, entry, at);
  // A09 — a re-check replaces what the analysis view shows for a requirement
  // and may clear BA decisions (audited by the findings run itself), so who
  // asked for it is recorded too.
  await prisma.auditLog.create({
    data: buildAuditLogData({
      actorId: input.actorId,
      action: "governing.requirement.recheck",
      targetType: "requirement",
      targetId: requirement.id,
      metadata: {
        analysisId,
        version: requirement.version,
        findings: run.written,
        removed: run.removed,
        decisionsCleared: run.decisionsCleared,
      },
    }),
  });
  log.info("governing requirement re-checked", {
    analysisId,
    requirementId: requirement.id,
    version: requirement.version,
    written: run.written,
    removed: run.removed,
  });
  return {
    ok: true,
    result: { requirementId: requirement.id, version: requirement.version, findings: run.written },
  };
}
