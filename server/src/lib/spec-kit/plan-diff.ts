/**
 * #1134 — what a re-run of `/speckit.plan` changed in the design: the
 * endpoints, the files and the functions the plan names, against the previous
 * plan.md. Run 8 re-planned an unchanged spec and moved the endpoint, the
 * handler file and the storage wrapper; the result card said nothing.
 */
import { listPlanEndpoints } from "./contract-check.js";
import { extractReferencedPaths } from "./grounding.js";

export interface SetChange {
  added: string[];
  removed: string[];
}

export interface PlanDesignDiff {
  endpoints: SetChange;
  files: SetChange;
  functions: SetChange;
}

/**
 * A backticked code identifier, optionally qualified (`store.Foo`) and
 * optionally called (`Foo()`). Only names with a lower-to-upper hump
 * (`WithLimit`, `markAllAsRead`) or a call suffix count, so `true`, `PUT`
 * and column names such as `read_at` are not read as functions.
 */
const IDENT_RE = /^(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)(\(\))?$/;

function namedFunctions(plan: string): string[] {
  const seen = new Set<string>();
  for (const m of plan.matchAll(/`([^`\n]{1,120})`/g)) {
    const id = IDENT_RE.exec(m[1]!.trim());
    if (!id) continue;
    if (id[2] === undefined && !/[a-z][A-Z]/.test(id[1]!)) continue;
    seen.add(m[1]!.trim().replace(/\(\)$/, ""));
  }
  return [...seen];
}

function change(before: string[], after: string[]): SetChange {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  };
}

export function diffPlanDesign(previous: string, next: string): PlanDesignDiff {
  const endpoints = (plan: string) => listPlanEndpoints(plan).map((e) => `${e.method} ${e.path}`);
  return {
    endpoints: change(endpoints(previous), endpoints(next)),
    files: change(extractReferencedPaths(previous), extractReferencedPaths(next)),
    functions: change(namedFunctions(previous), namedFunctions(next)),
  };
}

const LIST_CAP = 5;

function list(items: string[]): string {
  const shown = items.slice(0, LIST_CAP).map((x) => `\`${x}\``);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function describeChange(label: string, c: SetChange): string | null {
  if (c.added.length === 0 && c.removed.length === 0) return null;
  const parts = [
    c.added.length > 0 ? `added ${list(c.added)}` : "",
    c.removed.length > 0 ? `removed ${list(c.removed)}` : "",
  ].filter((p) => p.length > 0);
  return `${label} differ (${parts.join("; ")})`;
}

/**
 * One sentence for the result card: what differs from plan.md `previousVersion`,
 * or that the endpoints, files and functions are the same.
 */
export function describePlanDesignDiff(previousVersion: number, diff: PlanDesignDiff): string {
  const changed = [
    describeChange("endpoints", diff.endpoints),
    describeChange("files", diff.files),
    describeChange("functions", diff.functions),
  ].filter((p): p is string => p !== null);
  return changed.length === 0
    ? ` Compared with plan.md v${previousVersion}: the same endpoints, files and functions.`
    : ` Compared with plan.md v${previousVersion}: ${changed.join("; ")}. Artifacts generated from the earlier plan are out of date.`;
}

/**
 * The previous plan, given to the model as the starting point of a re-run
 * (#1134): an unchanged spec must not get a new design by chance.
 */
export function previousPlanSection(previous: { content: string; version: number }): string {
  // A fence longer than any backtick run inside, so a plan's own Mermaid fences cannot close it.
  const longest = Math.max(0, ...(previous.content.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [
    `Previous plan.md (v${previous.version}) — the starting point. Revise it rather than designing afresh:`,
    "keep its endpoints, the files it changes and the functions it adds or uses unless spec.md or the",
    "code context requires a change, and record each such change and its reason as an ADR under `## ADRs`.",
    `${fence}md`,
    previous.content,
    fence,
  ].join("\n");
}
