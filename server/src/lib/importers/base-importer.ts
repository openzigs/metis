/**
 * Dedup + upsert engine — issue #777.
 *
 * `runImport` drives a single import pass: stream items from an importer, map
 * each to a requirement, then upsert via a {@link RequirementStore} keyed on
 * (projectId, externalSource, externalId). Re-running the same import updates
 * existing rows instead of creating duplicates — the idempotency guarantee.
 *
 * The store is a port: production uses a Prisma-backed adapter, tests use an
 * in-memory fixture (see import-dedup.test.ts).
 */
import type { ExternalIssue, Importer, ImporterFetchContext, MappedRequirement } from "./types.js";

/** Shape persisted for each imported requirement. */
export interface RequirementUpsertInput {
  projectId: string;
  analysisId: string;
  importSourceId: string;
  externalSource: string;
  externalId: string;
  externalUrl: string;
  title: string;
  body: string;
  type: string;
  priority: string;
  labels: string[];
}

/** Persistence port. */
export interface RequirementStore {
  findByExternal(
    projectId: string,
    externalSource: string,
    externalId: string,
  ): Promise<{ id: string } | null>;
  create(input: RequirementUpsertInput): Promise<{ id: string }>;
  update(id: string, input: RequirementUpsertInput): Promise<{ id: string }>;
  /** Optional: set a requirement's parent (Azure DevOps hierarchy). */
  setParent?(childId: string, parentId: string): Promise<void>;
}

export interface RunImportOptions<F> {
  importer: Importer<F>;
  filter: F;
  store: RequirementStore;
  projectId: string;
  analysisId: string;
  importSourceId: string;
  ctx?: ImporterFetchContext;
}

export interface RunImportResult {
  created: number;
  updated: number;
  skipped: number;
  total: number;
}

const VALID_TYPES = new Set(["feature", "bug", "chore", "epic", "task"]);
const VALID_PRIORITIES = new Set(["low", "medium", "high", "critical"]);

/** Normalise a raw type hint + labels into a requirement type. */
export function normalizeType(raw: string | undefined, labels: string[]): string {
  const hint = (raw ?? "").toLowerCase();
  const lowered = labels.map((l) => l.toLowerCase());
  if (hint.includes("bug") || lowered.includes("bug")) return "bug";
  if (hint.includes("epic") || lowered.includes("epic")) return "epic";
  if (hint.includes("task") || hint.includes("chore")) return "task";
  if (VALID_TYPES.has(hint)) return hint;
  return "feature";
}

/** Normalise a raw priority hint + labels into a requirement priority. */
export function normalizePriority(raw: string | undefined, labels: string[]): string {
  const hint = (raw ?? "").toLowerCase();
  const lowered = labels.map((l) => l.toLowerCase());
  const fromLabel = lowered
    .map((l) => /(?:^|priority[:/-])\s*(low|medium|high|critical)$/.exec(l)?.[1])
    .find(Boolean);
  if (fromLabel && VALID_PRIORITIES.has(fromLabel)) return fromLabel;
  if (hint.includes("critical") || hint.includes("blocker") || hint.includes("highest"))
    return "critical";
  if (hint.includes("high") || hint.includes("urgent")) return "high";
  if (hint.includes("low") || hint.includes("trivial") || hint.includes("minor")) return "low";
  if (VALID_PRIORITIES.has(hint)) return hint;
  return "medium";
}

/** Default mapping shared by importers that don't override `map`. */
export function defaultMap(issue: ExternalIssue): MappedRequirement {
  return {
    externalId: issue.externalId,
    externalSource: issue.externalSource,
    externalUrl: issue.url,
    title: issue.title.trim(),
    body: issue.body ?? "",
    type: normalizeType(issue.type, issue.labels),
    priority: normalizePriority(issue.priority, issue.labels),
    labels: issue.labels,
    parentExternalId: issue.parentExternalId ?? null,
  };
}

/**
 * Execute one import pass. Idempotent: items already present (matched on
 * externalSource + externalId) are updated, not duplicated.
 */
export async function runImport<F>(opts: RunImportOptions<F>): Promise<RunImportResult> {
  const { importer, filter, store, projectId, analysisId, importSourceId, ctx } = opts;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let total = 0;

  // externalId -> requirement id (for resolving parent links afterwards).
  const idByExternal = new Map<string, string>();
  const parentEdges: Array<{ childExternalId: string; parentExternalId: string }> = [];

  for await (const issue of importer.fetchAll(filter, ctx)) {
    if (ctx?.signal?.aborted) break;
    total += 1;
    const mapped = importer.map(issue);
    if (!mapped.title) {
      skipped += 1;
      continue;
    }
    const input: RequirementUpsertInput = {
      projectId,
      analysisId,
      importSourceId,
      externalSource: mapped.externalSource,
      externalId: mapped.externalId,
      externalUrl: mapped.externalUrl,
      title: mapped.title,
      body: mapped.body,
      type: mapped.type,
      priority: mapped.priority,
      labels: mapped.labels,
    };
    const existing = await store.findByExternal(
      projectId,
      mapped.externalSource,
      mapped.externalId,
    );
    let requirementId: string;
    if (existing) {
      const res = await store.update(existing.id, input);
      requirementId = res.id;
      updated += 1;
    } else {
      const res = await store.create(input);
      requirementId = res.id;
      created += 1;
    }
    idByExternal.set(mapped.externalId, requirementId);
    if (mapped.parentExternalId) {
      parentEdges.push({
        childExternalId: mapped.externalId,
        parentExternalId: mapped.parentExternalId,
      });
    }
  }

  // Resolve parent/child hierarchy once everything is persisted.
  if (store.setParent && parentEdges.length > 0) {
    for (const edge of parentEdges) {
      const childId = idByExternal.get(edge.childExternalId);
      const parentId = idByExternal.get(edge.parentExternalId);
      if (childId && parentId) {
        await store.setParent(childId, parentId);
      }
    }
  }

  return { created, updated, skipped, total };
}
