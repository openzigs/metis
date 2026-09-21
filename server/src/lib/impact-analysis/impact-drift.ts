/**
 * Deterministic impact-drift differ — Issue #965 (Epic #960).
 *
 * Given a re-run (HEAD) and its original (BASE) — both already-persisted
 * {@link ImpactAnalysisDetail} projections — compute WHAT CHANGED per requirement:
 * affected tables added/removed/tier-changed, code symbols added/removed, and
 * confidence/severity deltas. This turns a one-shot impact report into living
 * traceability ("since last month, 2 new code sites touch `account.status`;
 * `signon` no longer affected").
 *
 * CONTRACT — this is a PURE function over the two runs' persisted rows:
 *   - It NEVER re-analyzes the old run and NEVER mutates either run (original runs
 *     are immutable).
 *   - It ignores volatile fields (row ids, timestamps): two runs against an
 *     IDENTICAL code graph therefore produce byte-identical impact content and an
 *     EMPTY diff (the determinism guarantee, asserted by the guard test).
 *   - Requirements are KEYED on `requirementId` when present, else a stable
 *     text-hash of the requirement title (nullable-`requirementId` free-text runs /
 *     removals — see `ImpactItem.requirementId`). The composite key also carries the
 *     project id (one persisted `ImpactItem` == one (run, project, requirement)).
 *
 * The delimiter in every composite key is a `|` pipe — NEVER a NUL byte (a literal
 * 0x00 corrupts the diff and trips the repo's `check-no-nul` guard).
 */
import type {
  ImpactAffectedTableView,
  ImpactAnalysisDetail,
  ImpactDriftReport,
  ImpactDriftSummary,
  ImpactDriftTierChange,
  ImpactItemView,
  RequirementDrift,
} from "@metis/shared";

/** The pipe delimiter used in every composite key (NEVER a NUL byte). */
const DELIM = "|";

/**
 * FNV-1a 32-bit string hash → 8-char hex. Pure, dependency-free, and stable across
 * Node/browser (so the shape can be re-derived anywhere). Used only to key
 * requirements that have no `requirementId` on a compact text fingerprint of their
 * title — collision resistance here only needs to separate DISTINCT titles within a
 * single run, which FNV-1a amply provides.
 */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (avoids BigInt / float precision loss).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The per-(project, requirement) match key. `requirementId` when the item is tied
 * to a tracked requirement; otherwise a text-hash of the requirement title so
 * nullable-`requirementId` runs still diff by requirement identity. Pipe-delimited,
 * NUL-free.
 */
export function requirementDriftKey(item: {
  projectId: string;
  requirementId: string | null;
  requirementTitle: string | null;
}): string {
  const reqPart = item.requirementId
    ? `req:${item.requirementId}`
    : `txt:${fnv1aHex(item.requirementTitle ?? "")}`;
  return `${item.projectId}${DELIM}${reqPart}`;
}

/** Identity of one affected-table row for set-diffing: `table` or `table.column`. */
function tableIdentity(t: ImpactAffectedTableView): string {
  return t.columnName ? `${t.tableName}.${t.columnName}` : t.tableName;
}

/** Identity of one affected code symbol for set-diffing: `file::qualifiedName`. */
function symbolIdentity(s: { filePath: string; qualifiedName: string }): string {
  return `${s.filePath}::${s.qualifiedName}`;
}

/** All affected tables of an item (primary + low-confidence secondary bucket). */
function allTables(item: ImpactItemView): ImpactAffectedTableView[] {
  return [...item.affectedTables, ...item.affectedTablesSecondary];
}

/** All affected code symbols of an item (production symbols + covering tests). */
function allSymbols(item: ImpactItemView): { filePath: string; qualifiedName: string }[] {
  return [...item.affectedSymbols, ...item.affectedTests];
}

/** Map an item's tables to identity → relevance tier (last write wins, stable). */
function tierByIdentity(
  item: ImpactItemView,
): Map<string, ImpactAffectedTableView["relevanceTier"]> {
  const m = new Map<string, ImpactAffectedTableView["relevanceTier"]>();
  for (const t of allTables(item)) m.set(tableIdentity(t), t.relevanceTier);
  return m;
}

/** Deterministic ascending string sort. */
function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** Index a run's items by their per-requirement drift key. */
function indexByKey(detail: ImpactAnalysisDetail): Map<string, ImpactItemView> {
  const m = new Map<string, ImpactItemView>();
  for (const item of detail.items) {
    // One (run, project, requirement) == one item; if two items ever collapse to
    // the same key (null-title free-text collision), the FIRST wins deterministically
    // (items arrive project-then-impactScore ordered from the read layer).
    const key = requirementDriftKey(item);
    if (!m.has(key)) m.set(key, item);
  }
  return m;
}

/** Compute the drift of one requirement present in base and/or head. */
function diffRequirement(
  key: string,
  base: ImpactItemView | undefined,
  head: ImpactItemView | undefined,
): RequirementDrift {
  const anchor = head ?? base;
  if (!anchor) {
    // Unreachable — a key exists only because one side had an item.
    throw new Error(`impact-drift: empty requirement key ${key}`);
  }

  const baseTables = base ? new Set(allTables(base).map(tableIdentity)) : new Set<string>();
  const headTables = head ? new Set(allTables(head).map(tableIdentity)) : new Set<string>();
  const tablesAdded = sorted([...headTables].filter((t) => !baseTables.has(t)));
  const tablesRemoved = sorted([...baseTables].filter((t) => !headTables.has(t)));

  const baseTier = base ? tierByIdentity(base) : new Map();
  const headTier = head ? tierByIdentity(head) : new Map();
  const tablesTierChanged: ImpactDriftTierChange[] = [];
  for (const id of [...headTables].filter((t) => baseTables.has(t))) {
    const from = baseTier.get(id) ?? null;
    const to = headTier.get(id) ?? null;
    if (from !== to) {
      const [tableName, columnName] = id.includes(".")
        ? [id.slice(0, id.indexOf(".")), id.slice(id.indexOf(".") + 1)]
        : [id, null];
      tablesTierChanged.push({ tableName, columnName, fromTier: from, toTier: to });
    }
  }
  tablesTierChanged.sort((a, b) =>
    `${a.tableName}.${a.columnName ?? ""}`.localeCompare(`${b.tableName}.${b.columnName ?? ""}`),
  );

  const baseSymbols = base ? new Set(allSymbols(base).map(symbolIdentity)) : new Set<string>();
  const headSymbols = head ? new Set(allSymbols(head).map(symbolIdentity)) : new Set<string>();
  const symbolsAdded = sorted([...headSymbols].filter((s) => !baseSymbols.has(s)));
  const symbolsRemoved = sorted([...baseSymbols].filter((s) => !headSymbols.has(s)));

  const confidenceDelta = base && head ? head.confidence - base.confidence : 0;
  const severityChanged =
    base && head && base.severity !== head.severity
      ? { from: base.severity, to: head.severity }
      : null;

  let status: RequirementDrift["status"];
  if (!base) status = "added";
  else if (!head) status = "removed";
  else {
    const changed =
      tablesAdded.length > 0 ||
      tablesRemoved.length > 0 ||
      tablesTierChanged.length > 0 ||
      symbolsAdded.length > 0 ||
      symbolsRemoved.length > 0 ||
      confidenceDelta !== 0 ||
      severityChanged !== null;
    status = changed ? "changed" : "unchanged";
  }

  return {
    key,
    projectId: anchor.projectId,
    requirementId: anchor.requirementId,
    requirementTitle: anchor.requirementTitle,
    status,
    tablesAdded,
    tablesRemoved,
    tablesTierChanged,
    symbolsAdded,
    symbolsRemoved,
    confidenceDelta,
    severityChanged,
  };
}

/**
 * Diff a HEAD (re-run) against a BASE (original) impact run. Pure + deterministic.
 * Returns every requirement whose impact actually changed (status ≠ `unchanged`),
 * sorted by key, plus roll-up counts. An identical code graph ⇒ empty
 * `requirements` and an all-zero summary.
 */
export function diffImpactRuns(
  base: ImpactAnalysisDetail,
  head: ImpactAnalysisDetail,
): ImpactDriftReport {
  const baseByKey = indexByKey(base);
  const headByKey = indexByKey(head);
  const allKeys = sorted(new Set([...baseByKey.keys(), ...headByKey.keys()]));

  const drifts = allKeys.map((key) => diffRequirement(key, baseByKey.get(key), headByKey.get(key)));

  const summary: ImpactDriftSummary = {
    requirementsAdded: 0,
    requirementsRemoved: 0,
    requirementsChanged: 0,
    requirementsUnchanged: 0,
    tablesAdded: 0,
    tablesRemoved: 0,
    symbolsAdded: 0,
    symbolsRemoved: 0,
  };
  for (const d of drifts) {
    if (d.status === "added") summary.requirementsAdded++;
    else if (d.status === "removed") summary.requirementsRemoved++;
    else if (d.status === "changed") summary.requirementsChanged++;
    else summary.requirementsUnchanged++;
    summary.tablesAdded += d.tablesAdded.length;
    summary.tablesRemoved += d.tablesRemoved.length;
    summary.symbolsAdded += d.symbolsAdded.length;
    summary.symbolsRemoved += d.symbolsRemoved.length;
  }

  return {
    headAnalysisId: head.id,
    baseAnalysisId: base.id,
    requirements: drifts.filter((d) => d.status !== "unchanged"),
    summary,
  };
}
