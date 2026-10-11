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

/** The marker on its own line, allowing list, quote and emphasis characters around it. */
const MARKER_RE = /^[\s>*_`-]*REST surface[*_`]*\s*[:—-]\s*[*_`]*\s*none\b/im;

/** Prose that says the same thing ("no REST endpoint is in scope"). */
const NO_REST_PHRASE_RE =
  /\bno\s+(?:new\s+)?(?:REST|HTTP|API)\s+(?:API\s+)?(?:endpoints?|surface|routes?)\s+(?:is|are)\s+(?:in\s+scope|added|introduced|required|needed|changed)\b/i;

/** A URL-path-like token: `/entries/{id}`, `/v1/entries/:id/read`. */
const PATH_TOKEN_RE = /\/[A-Za-z0-9._~{}:<>*-]+(?:\/[A-Za-z0-9._~{}:<>*-]+)*/g;

export interface ContractOperation {
  /** Upper-case HTTP method. */
  method: string;
  path: string;
}

/** `true` when plan.md carries the exact {@link NO_REST_SURFACE_MARKER} line. */
export function planHasNoRestSurfaceMarker(plan: string): boolean {
  return MARKER_RE.test(plan);
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
 * `true` when plan.md names the contract path: the same path, the path under a
 * prefix (`/v1/entries` for `/entries`), or its tail (`/entries` for
 * `/api/entries`). Parameter spelling (`{id}`, `:id`, `<id>`) is ignored.
 */
export function planMentionsPath(plan: string, path: string): boolean {
  const wanted = toSegments(path);
  if (wanted.length === 0) return true;
  for (const m of plan.matchAll(PATH_TOKEN_RE)) {
    const seen = toSegments(m[0]);
    if (endsWith(seen, wanted) || endsWith(wanted, seen)) return true;
  }
  return false;
}

/**
 * The contradictions between the contracts and plan.md, one sentence each:
 * an operation defined although the plan says no REST endpoint is in scope, or
 * an operation whose path the plan never names. `[]` when they agree, and for
 * a contract that cannot be parsed.
 */
export function findContractPlanContradictions(
  contracts: ReadonlyArray<{ key: string; content: string }>,
  plan: string,
): string[] {
  const noRest = planDeclaresNoRestSurface(plan);
  const out: string[] = [];
  for (const contract of contracts) {
    for (const op of listContractOperations(contract.content) ?? []) {
      const name = `\`${op.method} ${op.path}\``;
      if (noRest) {
        out.push(
          `plan.md states that no REST endpoint is in scope, but \`${contract.key}\` defines ${name}.`,
        );
      } else if (!planMentionsPath(plan, op.path)) {
        out.push(`\`${contract.key}\` defines ${name}, which plan.md never mentions.`);
      }
    }
  }
  return out;
}
