/**
 * #948 — the walkthrough test plan (`docs/walkthroughs/TEST_PLAN.md`) names API
 * routes and UI pages. When a feature PR removes or moves one, the plan keeps
 * pointing at it until a run trips over it: run 4 found two steps aimed at
 * routes that had been gone for weeks (`/projects/:id/test-coverage/connections`,
 * removed in #819, and the per-requirement traceability route, which moved).
 *
 * This module is the pure half of the drift check. It answers three questions
 * from text it is handed, with no file system access of its own, so every rule
 * is unit-testable on literals:
 *
 *  1. Which API routes does the server register? `collectApiRoutes` walks the
 *     Express mount graph from `server/src/app.ts` — `x.use("/prefix", …,
 *     fooRouter())` — through each imported router function, and joins the mount
 *     prefixes to the paths passed to `.get/.post/.put/.patch/.delete/.all`.
 *  2. Which UI paths have a page? `pagePatternsFromFiles` turns the Next.js app
 *     directory's `page.tsx` files into path patterns.
 *  3. Which API paths and pages does the plan name? `extractPlanReferences` reads
 *     inline code spans: `` `POST /api/projects/:id/analyses` `` is an API
 *     reference and `` `/projects/:id/settings` `` is a page reference.
 *
 * ## What it deliberately does not check
 *
 * A span that abbreviates its prefix with an ellipsis (`` `POST …/documents/url` ``)
 * is not checked: it is relative to whatever the sentence last named, and guessing
 * that prefix would turn this into a source of false failures. The plan's own
 * header tells authors which forms are checked.
 *
 * ## Why a regex walk and not the TypeScript compiler
 *
 * The check runs in CI's `changelog` job, which has no `pnpm install` and takes
 * seconds. The route files follow one shape — a router factory function that
 * calls `Router()` and registers literal paths — and the repository test
 * (`walkthrough-plan-drift-repo.test.mjs`) pins that the walk resolves every
 * mount in the real tree, so a server refactor that outgrows the regexes fails a
 * test rather than silently shrinking the route set.
 */

/** HTTP methods a route registration can use. `all` answers every method. */
export const ROUTE_METHODS = ["get", "post", "put", "patch", "delete", "all"];

/**
 * A route registration: `receiver.method("/literal/path"`. The path must be a
 * plain string literal starting with `/`; a template literal with `${…}` is
 * skipped by the caller.
 */
const REGISTRATION_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all)\(\s*(["'`])(\/[^"'`]*)\3/g;

/** A mount: `receiver.use("/prefix",` — the arguments after it are parsed by hand. */
const USE_RE = /\b([A-Za-z_$][\w$]*)\s*\.\s*use\(\s*(["'`])(\/[^"'`]*)\2\s*,/g;

/** `import { a, b as c } from "./x.js"` (single or multi-line). */
const IMPORT_RE = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

/** A top-level declaration at column 0, which starts a new chunk. */
const DECLARATION_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:])/gm;

/** Mount nesting deeper than this is a cycle, not a real router tree. */
const MAX_MOUNT_DEPTH = 12;

/**
 * Join two URL path pieces with exactly one `/` between them, no trailing slash
 * (except the root itself).
 *
 * @param {string} prefix
 * @param {string} suffix
 * @returns {string}
 */
export function joinPath(prefix, suffix) {
  const joined = `${prefix}/${suffix}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

/**
 * Local name → `{ specifier, imported }` for every named import.
 *
 * @param {string} source
 * @returns {Map<string, { specifier: string, imported: string }>}
 */
export function parseImports(source) {
  /** @type {Map<string, { specifier: string, imported: string }>} */
  const imports = new Map();
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[2];
    for (const raw of match[1].split(",")) {
      const part = raw.replace(/^\s*type\s+/, "").trim();
      if (part.length === 0) continue;
      const [imported, local] = part.split(/\s+as\s+/).map((s) => s.trim());
      imports.set(local ?? imported, { specifier, imported });
    }
  }
  return imports;
}

/**
 * Split a module into its top-level declarations. Each chunk runs from one
 * column-0 declaration to the next, so a router factory's chunk holds exactly
 * the registrations made inside it.
 *
 * @param {string} source
 * @returns {Map<string, string>} declared name → its text
 */
export function splitTopLevel(source) {
  /** @type {{ name: string, start: number }[]} */
  const starts = [];
  for (const match of source.matchAll(DECLARATION_RE)) {
    starts.push({ name: match[1] ?? match[2], start: match.index });
  }
  /** @type {Map<string, string>} */
  const chunks = new Map();
  starts.forEach((entry, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].start : source.length;
    chunks.set(entry.name, source.slice(entry.start, end));
  });
  return chunks;
}

/**
 * Split the argument list that starts at `openIndex` (just past a `(` whose
 * first argument has already been consumed) into top-level arguments, and
 * return the last one.
 *
 * @param {string} text
 * @param {number} fromIndex index just after the first argument's comma
 * @returns {string | null} the last argument's text, or null when unbalanced
 */
function lastArgument(text, fromIndex) {
  let depth = 0;
  let current = "";
  /** @type {string[]} */
  const args = [];
  /** @type {string | null} */
  let quote = null;
  for (let i = fromIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\") {
        current += text[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) {
        args.push(current.trim());
        const last = args.filter((a) => a.length > 0).at(-1);
        return last ?? null;
      }
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  return null;
}

/**
 * Classify the router expression passed last to `.use(…)`.
 *
 * @param {string} expr
 * @returns {{ kind: "call", name: string } | { kind: "member", object: string, property: string } | { kind: "identifier", name: string } | { kind: "other" }}
 */
export function classifyMountTarget(expr) {
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
  if (call) return { kind: "call", name: call[1] };
  const member = /^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(expr);
  if (member) return { kind: "member", object: member[1], property: member[2] };
  const ident = /^([A-Za-z_$][\w$]*)$/.exec(expr);
  if (ident) return { kind: "identifier", name: ident[1] };
  return { kind: "other" };
}

/**
 * Every literal route registration and every mount in one chunk of source.
 *
 * @param {string} chunk
 * @returns {{
 *   registrations: { receiver: string, method: string, path: string }[],
 *   mounts: { receiver: string, prefix: string, target: ReturnType<typeof classifyMountTarget> }[],
 * }}
 */
export function parseRouterChunk(chunk) {
  /** @type {{ receiver: string, method: string, path: string }[]} */
  const registrations = [];
  for (const match of chunk.matchAll(REGISTRATION_RE)) {
    if (match[4].includes("${")) continue;
    registrations.push({ receiver: match[1], method: match[2], path: match[4] });
  }
  /** @type {{ receiver: string, prefix: string, target: ReturnType<typeof classifyMountTarget> }[]} */
  const mounts = [];
  for (const match of chunk.matchAll(USE_RE)) {
    if (match[3].includes("${")) continue;
    const last = lastArgument(chunk, match.index + match[0].length);
    if (last === null) continue;
    mounts.push({ receiver: match[1], prefix: match[3], target: classifyMountTarget(last) });
  }
  return { registrations, mounts };
}

/**
 * Resolve a relative import specifier to the TypeScript source it names.
 * `./x.js` → `dir/x.ts`; anything non-relative (a package) is not ours to walk.
 *
 * @param {string} fromFile repo-relative, `/`-separated
 * @param {string} specifier
 * @returns {string | null}
 */
export function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const dir = fromFile.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") dir.pop();
    else dir.push(part);
  }
  return dir.join("/").replace(/\.js$/, ".ts");
}

/**
 * Walk the Express mount graph and list every registered route.
 *
 * @param {{
 *   entryFile: string,
 *   readSource: (file: string) => string | null,
 * }} options `readSource` returns null for a file that does not exist
 * @returns {{
 *   routes: { method: string, path: string, file: string }[],
 *   unresolved: { file: string, prefix: string, target: string }[],
 * }}
 */
export function collectApiRoutes({ entryFile, readSource }) {
  /** @type {Map<string, { chunks: Map<string, string>, imports: ReturnType<typeof parseImports> } | null>} */
  const modules = new Map();
  /** @param {string} file */
  const load = (file) => {
    if (!modules.has(file)) {
      const source = readSource(file);
      modules.set(
        file,
        source === null ? null : { chunks: splitTopLevel(source), imports: parseImports(source) },
      );
    }
    return modules.get(file) ?? null;
  };

  /** @type {{ method: string, path: string, file: string }[]} */
  const routes = [];
  /** @type {{ file: string, prefix: string, target: string }[]} */
  const unresolved = [];
  const seen = new Set();

  /**
   * Find the function a call name refers to, from inside `file`.
   *
   * @param {string} file
   * @param {string} name
   * @returns {{ file: string, fn: string } | null}
   */
  const resolveFunction = (file, name) => {
    const mod = load(file);
    if (mod === null) return null;
    if (mod.chunks.has(name)) return { file, fn: name };
    const imported = mod.imports.get(name);
    if (!imported) return null;
    const target = resolveSpecifier(file, imported.specifier);
    if (target === null) return null;
    const targetMod = load(target);
    if (targetMod === null || !targetMod.chunks.has(imported.imported)) return null;
    return { file: target, fn: imported.imported };
  };

  /**
   * @param {string} file
   * @param {string} chunkText
   * @param {string} prefix
   * @param {string | null} receiver only registrations on this variable, when set
   * @param {number} depth
   */
  const walkChunk = (file, chunkText, prefix, receiver, depth) => {
    if (depth > MAX_MOUNT_DEPTH) return;
    const { registrations, mounts } = parseRouterChunk(chunkText);
    // Sub-routers held in local variables are reached through their own mount
    // below; counting them at this chunk's prefix too would invent routes.
    const subRouters = new Set(
      mounts
        .filter((m) => m.target.kind === "identifier" && m.target.name !== m.receiver)
        .map((m) => (m.target.kind === "identifier" ? m.target.name : "")),
    );
    for (const reg of registrations) {
      if (receiver !== null ? reg.receiver !== receiver : subRouters.has(reg.receiver)) continue;
      routes.push({ method: reg.method, path: joinPath(prefix, reg.path), file });
    }
    for (const mount of mounts) {
      if (receiver !== null && mount.receiver !== receiver) continue;
      const mountPrefix = joinPath(prefix, mount.prefix);
      const { target } = mount;
      if (target.kind === "call") {
        const fn = resolveFunction(file, target.name);
        if (fn === null) {
          // Middleware factories (`requireProjectAccess("id")`, `express.json()`)
          // land here and contribute no routes, correctly. A name that reads
          // like a router is reported so a walk that lost one is visible.
          if (/router$/i.test(target.name)) {
            unresolved.push({ file, prefix: mountPrefix, target: target.name });
          }
          continue;
        }
        walkFunction(fn.file, fn.fn, mountPrefix, null, depth + 1);
      } else if (target.kind === "member") {
        const assigned = new RegExp(
          `\\b(?:const|let|var)\\s+${target.object.replace(/\$/g, "\\$")}\\s*=\\s*(?:await\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(`,
        ).exec(chunkText);
        const fn = assigned ? resolveFunction(file, assigned[1]) : null;
        if (fn === null) {
          unresolved.push({
            file,
            prefix: mountPrefix,
            target: `${target.object}.${target.property}`,
          });
          continue;
        }
        walkFunction(fn.file, fn.fn, mountPrefix, target.property, depth + 1);
      } else if (target.kind === "identifier" && target.name !== mount.receiver) {
        // A sub-router held in a local variable: its registrations live in
        // this same chunk under that receiver name. A bare identifier that is
        // not such a variable is middleware (`requireAuth`) and adds nothing.
        walkChunk(file, chunkText, mountPrefix, target.name, depth + 1);
      }
    }
  };

  /**
   * @param {string} file
   * @param {string} fn
   * @param {string} prefix
   * @param {string | null} receiver
   * @param {number} depth
   */
  const walkFunction = (file, fn, prefix, receiver, depth) => {
    const key = `${file}#${fn}#${prefix}#${receiver ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const mod = load(file);
    const chunk = mod?.chunks.get(fn);
    if (chunk === undefined) return;
    walkChunk(file, chunk, prefix, receiver, depth);
  };

  const entry = load(entryFile);
  if (entry !== null) {
    for (const [fn] of entry.chunks) walkFunction(entryFile, fn, "", null, 0);
  }
  return { routes, unresolved };
}

/**
 * One path segment, classified for matching.
 *
 * @typedef {{ kind: "literal", value: string } | { kind: "param" } | { kind: "optional" } | { kind: "rest", min: number }} Segment
 */

/**
 * Parse an Express route path into segments.
 *
 * @param {string} path
 * @returns {Segment[]}
 */
export function routeSegments(path) {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      if (/^\{?\*/.test(s)) return { kind: "rest", min: 1 };
      if (/^\{:[^}]+\}$/.test(s) || /^:[^/]+\?$/.test(s)) return { kind: "optional" };
      if (s.startsWith(":")) return { kind: "param" };
      return { kind: "literal", value: s };
    });
}

/**
 * Parse a path as the plan writes it: `:id`, `<id>`, `{id}` and `[id]` are all
 * placeholders; `*key` is a placeholder for the rest of the path.
 *
 * @param {string} path
 * @returns {Segment[]}
 */
export function referenceSegments(path) {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      if (s.startsWith("*")) return { kind: "rest", min: 1 };
      if (/^(:.+|<.+>|\{.+\}|\[.+\])$/.test(s)) return { kind: "param" };
      return { kind: "literal", value: s };
    });
}

/**
 * Parse a Next.js app-directory page file into path segments.
 *
 * @param {string} pageFile path relative to the app directory, e.g.
 *   `(authed)/projects/[id]/page.tsx`
 * @returns {Segment[]}
 */
export function pageSegments(pageFile) {
  return pageFile
    .split("/")
    .slice(0, -1)
    .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s) && !s.startsWith("@"))
    .map((s) => {
      if (/^\[\[\.\.\..+\]\]$/.test(s)) return { kind: "rest", min: 0 };
      if (/^\[\.\.\..+\]$/.test(s)) return { kind: "rest", min: 1 };
      if (/^\[.+\]$/.test(s)) return { kind: "param" };
      return { kind: "literal", value: s };
    });
}

/**
 * Does a referenced path fit the start of a registered pattern? This is how a
 * method-less mention of a mount point — "mounted at
 * `/api/projects/:projectId/spec-kit`" — resolves: some route lives under it.
 *
 * @param {Segment[]} ref
 * @param {Segment[]} pattern
 * @returns {boolean}
 */
export function segmentsPrefixMatch(ref, pattern) {
  for (let k = 0; k <= pattern.length; k += 1) {
    if (segmentsMatch(ref, pattern.slice(0, k))) return true;
  }
  return false;
}

/**
 * Does a referenced path fit a registered pattern?
 *
 * A placeholder in the reference only fits a placeholder in the pattern: the
 * plan's `:id` cannot be the literal `install`. A literal in the reference fits
 * a pattern placeholder, which is how `/api/admin/config/MODEL_PRICES` matches
 * `/config/:key`.
 *
 * @param {Segment[]} ref
 * @param {Segment[]} pattern
 * @returns {boolean}
 */
export function segmentsMatch(ref, pattern) {
  if (pattern.length === 0) return ref.length === 0;
  const [head, ...tail] = pattern;
  if (head.kind === "rest") {
    for (let take = head.min; take <= ref.length; take += 1) {
      if (segmentsMatch(ref.slice(take), tail)) return true;
    }
    return false;
  }
  if (head.kind === "optional") {
    if (segmentsMatch(ref, tail)) return true;
    return ref.length > 0 && ref[0].kind !== "rest" && segmentsMatch(ref.slice(1), tail);
  }
  if (ref.length === 0) return false;
  const [first, ...rest] = ref;
  if (first.kind === "rest") return false;
  if (head.kind === "param") return segmentsMatch(rest, tail);
  return first.kind === "literal" && first.value === head.value && segmentsMatch(rest, tail);
}

/**
 * An API path inside a span, optionally after its method(s). The lookbehind
 * keeps `internal/api/entry_handlers.go` — a file path that merely contains
 * `/api/` — from reading as a route.
 */
const API_IN_SPAN_RE =
  /(?:\b((?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))*)\s+)?(?<![\w./-])(\/api(?:\/[^\s'"`),{]*)?)/g;

const PAGE_SPAN_RE = /^(\/[^\s?#]*)(?:[?#]\S*)?$/;

/** A line carrying this marker is not checked — for a deliberate dead link. */
export const SKIP_MARKER = "<!-- drift-check: skip -->";

/**
 * Expand `a|b|c` alternatives inside a path segment into separate paths:
 * `/api/ai/sessions/:id/resume|fork|compact` names three routes.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function expandAlternatives(path) {
  const segments = path.split("/");
  /** @type {string[]} */
  let results = [""];
  segments.forEach((segment, i) => {
    const options = segment.split("|");
    results = results.flatMap((prefix) =>
      options.map((option) => (i === 0 ? option : `${prefix}/${option}`)),
    );
  });
  return results;
}

/**
 * Strip what cannot be part of the path itself: a query or fragment, and
 * sentence punctuation that ended up inside the span.
 *
 * @param {string} path
 * @returns {string}
 */
function cleanPath(path) {
  return path.replace(/[?#].*$/, "").replace(/[.,;:]+$/, "");
}

/**
 * Every checkable API and page reference in the plan.
 *
 * Only inline code spans outside fenced blocks are read: a fenced block holds
 * shell and SQL, where a `/path` is a file, not a page.
 *
 * @param {string} markdown
 * @returns {{ kind: "api" | "page", methods: string[], path: string, line: number, span: string }[]}
 */
export function extractPlanReferences(markdown) {
  /** @type {{ kind: "api" | "page", methods: string[], path: string, line: number, span: string }[]} */
  const refs = [];
  let fenced = false;
  markdown.split("\n").forEach((text, index) => {
    const line = index + 1;
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (fenced || text.includes(SKIP_MARKER)) return;
    for (const spanMatch of text.matchAll(/`([^`]+)`/g)) {
      const span = spanMatch[1].trim();
      if (span.includes("://")) continue;
      let sawApi = false;
      for (const api of span.matchAll(API_IN_SPAN_RE)) {
        sawApi = true;
        if (api[2].includes("…") || api[2].includes("...")) continue;
        const raw = cleanPath(api[2]);
        const methods = api[1] ? api[1].toLowerCase().split("/") : [];
        for (const path of expandAlternatives(raw)) {
          refs.push({ kind: "api", methods, path, line, span });
        }
      }
      if (sawApi) continue;
      const page = PAGE_SPAN_RE.exec(span);
      if (page && !page[1].includes("…") && !page[1].includes("...") && !page[1].includes("*")) {
        for (const path of expandAlternatives(cleanPath(page[1]))) {
          refs.push({ kind: "page", methods: [], path, line, span });
        }
      }
    }
  });
  return refs;
}

/**
 * The plan's references that match nothing the tree serves.
 *
 * @param {{
 *   refs: ReturnType<typeof extractPlanReferences>,
 *   apiRoutes: { method: string, path: string }[],
 *   pageFiles: string[],
 * }} input
 * @returns {{ line: number, kind: "api" | "page", reference: string, span: string }[]}
 */
export function findPlanDrift({ refs, apiRoutes, pageFiles }) {
  const routePatterns = apiRoutes.map((r) => ({
    method: r.method,
    segments: routeSegments(r.path),
  }));
  const pagePatterns = pageFiles.map(pageSegments);
  /** @type {{ line: number, kind: "api" | "page", reference: string, span: string }[]} */
  const problems = [];
  for (const ref of refs) {
    const segments = referenceSegments(ref.path);
    let ok;
    if (ref.kind === "api") {
      // With a method the reference names one endpoint, so it must match a
      // whole route. Without one it may name a resource or a mount point,
      // which is alive while anything is registered under it.
      ok =
        ref.methods.length === 0
          ? routePatterns.some((route) => segmentsPrefixMatch(segments, route.segments))
          : ref.methods.every((method) =>
              routePatterns.some(
                (route) =>
                  (route.method === "all" || route.method === method) &&
                  segmentsMatch(segments, route.segments),
              ),
            );
    } else {
      ok = pagePatterns.some((pattern) => segmentsMatch(segments, pattern));
    }
    if (!ok) {
      const methods = ref.methods.length > 0 ? `${ref.methods.join("/").toUpperCase()} ` : "";
      problems.push({
        line: ref.line,
        kind: ref.kind,
        reference: `${methods}${ref.path}`,
        span: ref.span,
      });
    }
  }
  return problems;
}
