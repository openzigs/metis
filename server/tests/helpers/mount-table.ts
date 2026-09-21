/**
 * Issue #1058 (epic #1051) — static reader for the `apiRouter()` mount table.
 *
 * The project-scope guard test must be driven by the REAL mount table in
 * `server/src/routes/index.ts`, not by a hardcoded list: a hardcoded list is
 * exactly the thing that goes stale when someone adds router number 32.
 *
 * Express 5 keeps no record of the path a router was mounted at (`Layer.path`
 * is only populated during matching, and `Layer.keys` is empty for a `.use()`
 * mount), so the mount *paths* and the router *names* have to come from the
 * source text. The runtime `Router.stack` then supplies the middleware stacks.
 * The two halves are zipped positionally and cross-checked by replaying each
 * parsed path through the corresponding layer's own matcher, so a parser drift
 * fails the test loudly instead of silently skipping routers.
 */
import { readFileSync } from "node:fs";

/** One handler argument of one `r.use(...)` call in the mount table. */
export interface MountedHandler {
  /** Mount path as written in `index.ts`, or `null` for a path-less `r.use(mw)`. */
  path: string | null;
  /** Source text of this handler argument, e.g. `connectorsRouter()`. */
  expression: string;
  /** Source text of every handler argument in the same `r.use(...)` call. */
  siblings: string[];
  /** 1-based line of the `r.use(` call in `index.ts`, for failure messages. */
  line: number;
}

const USE_CALL = "r.use(";

/**
 * Split `text` on top-level commas, ignoring commas nested in brackets,
 * strings, or template literals.
 */
function splitTopLevelArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Read the string literal at the head of `text`, or `null` if there is none. */
function leadingStringLiteral(text: string): string | null {
  const quote = text[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const end = text.indexOf(quote, 1);
  if (end === -1) return null;
  // Reject anything but a plain literal (no concatenation / interpolation).
  if (text.slice(end + 1).trim().length > 0) return null;
  return text.slice(1, end);
}

/**
 * Parse every `r.use(...)` call in the `apiRouter()` body of `source`, in
 * registration order, flattened to one entry per handler argument — which is
 * exactly one Express layer each, so the result zips 1:1 with `Router.stack`.
 */
export function parseMountTable(source: string): MountedHandler[] {
  const bodyStart = source.indexOf("export function apiRouter()");
  if (bodyStart === -1) {
    throw new Error("mount-table parser: `export function apiRouter()` not found in index.ts");
  }
  const body = source.slice(bodyStart);
  const handlers: MountedHandler[] = [];

  let cursor = 0;
  for (;;) {
    const at = body.indexOf(USE_CALL, cursor);
    if (at === -1) break;
    // Balance parentheses to find the end of the call's argument list.
    let depth = 1;
    let i = at + USE_CALL.length;
    let quote: string | null = null;
    for (; i < body.length && depth > 0; i += 1) {
      const ch = body[i];
      if (quote) {
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
    }
    if (depth !== 0) {
      throw new Error(`mount-table parser: unbalanced r.use( at offset ${at}`);
    }
    const args = splitTopLevelArgs(body.slice(at + USE_CALL.length, i - 1));
    cursor = i;
    if (args.length === 0) continue;

    const path = leadingStringLiteral(args[0]);
    const handlerArgs = path === null ? args : args.slice(1);
    const line = source.slice(0, bodyStart + at).split("\n").length;
    for (const expression of handlerArgs) {
      handlers.push({ path, expression, siblings: handlerArgs, line });
    }
  }
  return handlers;
}

/** Read + parse the real mount table from `server/src/routes/index.ts`. */
export function readMountTable(indexPath: string): MountedHandler[] {
  return parseMountTable(readFileSync(indexPath, "utf8"));
}

/** True when a mount path carries a `:projectId` path parameter. */
export function isProjectScopedPath(path: string | null): path is string {
  return path !== null && /(^|\/):projectId(\/|$)/.test(path);
}
