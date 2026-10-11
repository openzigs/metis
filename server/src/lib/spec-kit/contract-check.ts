/**
 * #1065 — deterministic cross-check of a feature's OpenAPI contract against its
 * plan.md.
 *
 * In walkthrough run 7 the contract defined `PUT /entries/mark-all-as-read`
 * while plan.md said no REST endpoint was in scope, and `/speckit.analyze`
 * (which read only spec, plan and tasks) reported nothing. The model is still
 * asked to compare the documents, but a contradiction this mechanical is not
 * left to it: every operation the contract defines is checked against what the
 * plan says, in code.
 *
 * Pure (text in → findings out), so `/speckit.plan` and `/speckit.analyze`
 * share it and it is testable without a model.
 */
import yaml from "js-yaml";

/**
 * The line `/speckit.plan` asks plan.md to carry when the feature adds or
 * changes no REST/HTTP endpoint. When it is present the contract is written
 * without any path, and no model call is made for it.
 */
export const NO_REST_SURFACE_MARKER = "REST surface: none";

/** The OpenAPI extension an explicit "no REST surface" contract carries. */
export const NO_REST_SURFACE_EXTENSION = "x-no-rest-surface";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

/**
 * The marker as a WHOLE line: list, quote and emphasis characters may wrap it,
 * and only punctuation, emphasis or whitespace may follow `none`. A sentence
 * that merely starts the same way ("REST surface: none of the existing
 * endpoints change; adds POST /x") is not the marker.
 */
const MARKER_LINE_RE = /^[\s>*_`-]*REST surface[*_`]*\s*[:—-]\s*[*_`]*\s*none[\s*_`.,;:!]*$/i;

/** A line that opens or closes a fenced code block (``` or ~~~), quoted or not. */
const FENCE_RE = /^[\s>]*(?:```|~~~)/;

/** Prose that says the same thing ("no REST endpoint is in scope"). */
const NO_REST_PHRASE_RE =
  /\bno\s+(?:new\s+)?(?:REST|HTTP|API)\s+(?:API\s+)?(?:endpoints?|surface|routes?)\s+(?:is|are)\s+(?:in\s+scope|added|introduced|required|needed|changed)\b/i;

const PATH_CHARS = "[A-Za-z0-9._~{}:<>-]";

/**
 * A URL-path token the plan states on its own: `/entries/{id}`,
 * `/v1/entries/:id/read`. It must START at a delimiter (line start, whitespace,
 * a quote, backtick, bracket or table bar), so the tail of a file path
 * (`ui/src/app/entries`), a template (`specs/<slug>`) or prose (`and/or`) is
 * not read as an endpoint path.
 */
const PATH_TOKEN_RE = new RegExp(`(?<![^\\s\`'"(\\[|])/${PATH_CHARS}+(?:/${PATH_CHARS}+)*`, "g");

/** An endpoint stated as `METHOD /path` (upper-case method), emphasis allowed between. */
const ENDPOINT_RE = new RegExp(
  `\\b(GET|PUT|POST|DELETE|PATCH|OPTIONS|HEAD|TRACE)[\`*_|]*[ \\t]+[\`*_| \\t]*(/${PATH_CHARS}+(?:/${PATH_CHARS}+)*)`,
  "g",
);

export interface ContractOperation {
  /** Upper-case HTTP method. */
  method: string;
  path: string;
}

/** The plan without the lines inside fenced code blocks (an example is not a statement). */
function outsideFences(plan: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of plan.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) fenced = !fenced;
    else if (!fenced) out.push(line);
  }
  return out;
}

/**
 * Every endpoint plan.md states as `METHOD /path`, in order, without repeats.
 * Fenced blocks are read too: an HTTP example there still names an endpoint.
 */
export function listPlanEndpoints(plan: string): ContractOperation[] {
  const seen = new Set<string>();
  const out: ContractOperation[] = [];
  for (const m of plan.matchAll(ENDPOINT_RE)) {
    const path = m[2]!.replace(/[.:]+$/, "");
    const id = `${m[1]} ${path}`;
    if (path.length < 2 || seen.has(id)) continue;
    seen.add(id);
    out.push({ method: m[1]!, path });
  }
  return out;
}

/**
 * `true` when plan.md carries the {@link NO_REST_SURFACE_MARKER} line: as a
 * whole line, outside any fenced code block, and in a plan that names no
 * `METHOD /path` endpoint anywhere. A plan that says both is not trusted to
 * mean "none" — the contract is then derived from the plan as usual.
 */
export function planHasNoRestSurfaceMarker(plan: string): boolean {
  if (!outsideFences(plan).some((line) => MARKER_LINE_RE.test(line))) return false;
  return listPlanEndpoints(plan).length === 0;
}

/** `true` when plan.md says, by the marker or in prose, that no REST endpoint is in scope. */
export function planDeclaresNoRestSurface(plan: string): boolean {
  return planHasNoRestSurfaceMarker(plan) || NO_REST_PHRASE_RE.test(plan);
}

/**
 * Every path operation an OpenAPI document defines. `null` when the text is not
 * a YAML mapping (nothing can be said about it); `[]` when it defines none.
 */
export function listContractOperations(contract: string): ContractOperation[] | null {
  let doc: unknown;
  try {
    doc = yaml.load(contract);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const paths = (doc as Record<string, unknown>).paths;
  if (!paths || typeof paths !== "object") return [];
  const out: ContractOperation[] = [];
  for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
    if (!item || typeof item !== "object") continue;
    for (const method of HTTP_METHODS) {
      if (method in (item as Record<string, unknown>)) {
        out.push({ method: method.toUpperCase(), path });
      }
    }
  }
  return out;
}

/** A path as comparable segments: lower-case, every parameter style folded to `{}`. */
function toSegments(path: string): string[] {
  return path
    .replace(/[.:]+$/, "")
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (/^[{:<]/.test(s) ? "{}" : s.toLowerCase()));
}

function endsWith(long: string[], tail: string[]): boolean {
  if (tail.length === 0 || tail.length > long.length) return false;
  const offset = long.length - tail.length;
  return tail.every((s, i) => long[offset + i] === s);
}

/**
 * `true` when two paths are the same endpoint path: equal, or one is the other
 * under a prefix (`/v1/entries` and `/entries`). Parameter spelling (`{id}`,
 * `:id`, `<id>`) is ignored. A tail made only of parameters matches nothing but
 * itself — `/:id` is not `/entries/{entryID}`.
 */
function samePath(a: string[], b: string[]): boolean {
  if (a.length === b.length) return a.every((s, i) => s === b[i]);
  const [long, tail] = a.length > b.length ? [a, b] : [b, a];
  return tail.some((s) => s !== "{}") && endsWith(long, tail);
}

/**
 * `true` when plan.md names the contract path as a path of its own — after a
 * method (`PUT /entries`) or as a delimited token (`` `/entries` ``): the same
 * path, the path under a prefix (`/v1/entries` for `/entries`), or its tail
 * (`/entries` for `/api/entries`). A path that is only the tail of a file path
 * or of a word (`ui/src/app/entries`, `and/or`) does not count.
 */
export function planMentionsPath(plan: string, path: string): boolean {
  const wanted = toSegments(path);
  if (wanted.length === 0) return true;
  for (const m of plan.matchAll(PATH_TOKEN_RE)) {
    if (samePath(toSegments(m[0]), wanted)) return true;
  }
  return false;
}

const show = (op: ContractOperation): string => `\`${op.method} ${op.path}\``;

/**
 * The contradictions between the contracts and plan.md, one sentence each.
 * Method and path are compared together, in both directions:
 *   - an operation defined although the plan says no REST endpoint is in scope;
 *   - an operation the plan names under a different method;
 *   - an operation whose path the plan never names;
 *   - an endpoint the plan names as `METHOD /path` that no contract defines.
 * `[]` when they agree. A contract that cannot be parsed contributes nothing,
 * and silences the last check (its operations are unknown).
 */
export function findContractPlanContradictions(
  contracts: ReadonlyArray<{ key: string; content: string }>,
  plan: string,
): string[] {
  const noRest = planDeclaresNoRestSurface(plan);
  const planned = listPlanEndpoints(plan).map((op) => ({ op, segments: toSegments(op.path) }));
  const defined: Array<{ op: ContractOperation; segments: string[] }> = [];
  /** Plan endpoints already named in a method-mismatch sentence. */
  const reported = new Set<ContractOperation>();
  let allParsed = contracts.length > 0;
  const out: string[] = [];
  for (const contract of contracts) {
    const ops = listContractOperations(contract.content);
    if (ops === null) {
      allParsed = false;
      continue;
    }
    for (const op of ops) {
      const segments = toSegments(op.path);
      defined.push({ op, segments });
      if (noRest) {
        out.push(
          `plan.md states that no REST endpoint is in scope, but \`${contract.key}\` defines ${show(op)}.`,
        );
        continue;
      }
      const samePathInPlan = planned.filter((p) => samePath(p.segments, segments));
      if (samePathInPlan.some((p) => p.op.method === op.method)) continue;
      if (samePathInPlan.length > 0) {
        for (const p of samePathInPlan) reported.add(p.op);
        out.push(
          `\`${contract.key}\` defines ${show(op)}, but plan.md names that path as ${samePathInPlan.map((p) => show(p.op)).join(", ")}.`,
        );
      } else if (!planMentionsPath(plan, op.path)) {
        out.push(`\`${contract.key}\` defines ${show(op)}, which plan.md never mentions.`);
      }
    }
  }
  if (noRest || !allParsed) return out;
  const where =
    contracts.length === 1 ? `\`${contracts[0]!.key}\` does not define` : "no contract defines";
  for (const p of planned) {
    if (reported.has(p.op)) continue;
    const inContract = defined.some(
      (d) => d.op.method === p.op.method && samePath(d.segments, p.segments),
    );
    if (!inContract) {
      out.push(
        `plan.md names ${show(p.op)}, which ${where} (expected only for an existing endpoint this feature leaves unchanged).`,
      );
    }
  }
  return out;
}
