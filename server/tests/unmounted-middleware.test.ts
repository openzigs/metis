/**
 * Issue #1083 — an exported middleware that no production module imports is a
 * TRAP, not merely dead code.
 *
 * The companion ratchet `project-access-guard.test.ts` (#1058) asks "does this
 * mounted router carry its guard". It cannot see the failure that produced
 * #1083, which is the mirror image: a guard that exists, is exported, is
 * tested, reads as authoritative — and is mounted NOWHERE.
 *
 * `requireWorkspaceAccess` was that shape. It sat in `src/middleware/` with a
 * full test suite while `requireProjectAccess` (#674) did the real work, and
 * two comments in `lib/custom-agents/authz.ts` cited the unmounted one as the
 * behavioural standard ("matching the existing requireWorkspaceAccess
 * behaviour"). A reader following that citation would have copied a predicate
 * that never ran, and inherited the `workspaceScopeFilter` bug of #1066 — the
 * near-miss #1052 actually hit. Dead authorization code is worse than absent
 * authorization code, because it answers the question "what is the rule here?"
 * with something no request has ever been subject to.
 *
 * WHAT THIS TEST CHECKS. Every handler-shaped export of a
 * `server/src/middleware/*.ts` module must be IMPORTED by at least one
 * non-test module under `server/src/`.
 *
 * Two properties make this precise rather than noisy:
 *
 *   1. Reachability is measured by IMPORT, not by text search. A word-boundary
 *      grep for `requireWorkspaceAccess` across `src/` finds a hit — inside the
 *      very comment that mis-cited it. The citation made the corpse look alive
 *      to a naive scan, so the scan has to read import statements.
 *   2. Only HANDLER-SHAPED exports are in scope — those declaring a parameter
 *      list ending in `next`. `server/src/middleware/` also exports test-only
 *      reset hooks (`__resetAIRateLimiter`), classification tables and pure
 *      helpers, and demanding a production importer for those would be a false
 *      positive. Measured on the tree at the time of writing, this predicate
 *      flags exactly one of the sixteen unimported exports, and recognises all
 *      five known-good mounted guards (anchored below).
 *
 * Colocated `*.test.ts` files do NOT count as importers: being exercised by a
 * test is exactly the property `requireWorkspaceAccess` had, and it is what
 * made the module look maintained.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_SRC = fileURLToPath(new URL("../src", import.meta.url));
const MIDDLEWARE_DIR = join(SERVER_SRC, "middleware");

/**
 * Middleware exports that are not imported by any production module and have
 * been reviewed as acceptable anyway.
 *
 * THIS LIST MAY ONLY SHRINK. It is empty, and an empty ratchet is the point:
 * there is currently no unmounted middleware in the tree, so the next one is a
 * new defect rather than inherited debt. Do not append here to silence a red
 * test — either mount the middleware, or delete it.
 */
const UNMOUNTED_MIDDLEWARE_BASELINE: readonly string[] = [];

/** `<file> :: <export>` — stable identity for one middleware export. */
function exportKey(file: string, name: string): string {
  return `${file} :: ${name}`;
}

/** Every `.ts` file under `dir`, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const NAMED_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g;
const WHOLE_MODULE_IMPORT =
  /import\s+(?:\*\s+as\s+[A-Za-z0-9_$]+|[A-Za-z0-9_$]+)\s+from\s*["'](\.[^"']+)["']/g;

export interface MiddlewareImports {
  /** Named imports of middleware modules, across all production modules. */
  names: Set<string>;
  /** Middleware modules pulled in wholesale (`import * as ns` / default). */
  wholeModules: Set<string>;
}

/**
 * Collect every middleware symbol imported by a production module.
 *
 * Import specifiers are resolved against the importing file's directory so a
 * same-directory `./http-status-errors.js` counts exactly like a cross-tree
 * `../middleware/auth.js` — otherwise middleware composed by other middleware
 * would read as unreachable.
 */
export function collectMiddlewareImports(
  files: readonly string[],
  middlewareDir: string,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): MiddlewareImports {
  const names = new Set<string>();
  const wholeModules = new Set<string>();

  const targetsMiddleware = (from: string, specifier: string): string | null => {
    const resolved = resolve(dirname(from), specifier).replace(/\.js$/, ".ts");
    return dirname(resolved) === middlewareDir ? resolved : null;
  };

  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(NAMED_IMPORT)) {
      if (!targetsMiddleware(file, match[2])) continue;
      for (const raw of match[1].split(",")) {
        const name = raw
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim();
        if (name) names.add(name);
      }
    }
    for (const match of source.matchAll(WHOLE_MODULE_IMPORT)) {
      const target = targetsMiddleware(file, match[1]);
      if (target) wholeModules.add(target);
    }
  }
  return { names, wholeModules };
}

const EXPORTED_VALUE =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|function|class)\s+([A-Za-z0-9_$]+)/gm;

/**
 * A parameter list whose LAST parameter is `next` (or `_next`) — the signature
 * every Express handler and error handler has, and nothing else in this
 * directory does. Tolerates a type annotation and a trailing comma so a
 * multi-line factory signature is recognised as readily as a one-liner.
 */
const HANDLER_SIGNATURE = /\b_?next\b[^,()]*,?\s*\)/;

export interface MiddlewareExport {
  file: string;
  name: string;
  /** True when the export declares (or returns) an Express handler. */
  handlerShaped: boolean;
}

/**
 * Split a middleware module into its top-level exported values, each paired
 * with the source text running up to the next export — the span in which its
 * handler signature, if any, must appear.
 */
export function parseMiddlewareExports(file: string, source: string): MiddlewareExport[] {
  const starts = [...source.matchAll(EXPORTED_VALUE)].map((m) => ({
    name: m[1],
    at: m.index ?? 0,
  }));
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : source.length;
    return {
      file,
      name: start.name,
      handlerShaped: HANDLER_SIGNATURE.test(source.slice(start.at, end)),
    };
  });
}

const middlewareFiles = readdirSync(MIDDLEWARE_DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .sort();

const productionFiles = walk(SERVER_SRC).filter((f) => !f.endsWith(".test.ts"));
const { names: importedNames, wholeModules } = collectMiddlewareImports(
  productionFiles,
  MIDDLEWARE_DIR,
);

const allExports = middlewareFiles.flatMap((file) =>
  parseMiddlewareExports(file, readFileSync(join(MIDDLEWARE_DIR, file), "utf8")),
);

const unreachable = allExports.filter(
  (e) =>
    e.handlerShaped &&
    !importedNames.has(e.name) &&
    !wholeModules.has(join(MIDDLEWARE_DIR, e.file)),
);

describe("every exported middleware is reachable from production code", () => {
  it("enumerates the middleware directory it is meant to police", () => {
    // A ratchet that silently scans nothing passes forever. Anchor the corpus.
    // Floors sit below the measured corpus (24 middleware modules, 848
    // production files at the time of writing) with headroom for deletions.
    expect(middlewareFiles.length).toBeGreaterThanOrEqual(20);
    expect(allExports.length).toBeGreaterThanOrEqual(30);
    expect(productionFiles.length).toBeGreaterThanOrEqual(500);
  });

  it("recognises the known-good mounted guards as handler-shaped", () => {
    // If the shape detector stops seeing handlers it should see, the headline
    // assertion below goes quiet for the wrong reason. These go red first.
    const shaped = new Set(allExports.filter((e) => e.handlerShaped).map((e) => e.name));
    for (const guard of [
      "requireAuth",
      "requirePermission",
      "requireProjectAccess",
      "requireWorkspaceRole",
      "errorHandler",
    ]) {
      expect(shaped, `${guard} should be detected as handler-shaped`).toContain(guard);
    }
  });

  it("does not demand a production importer for test-only helpers", () => {
    // The complementary failure: a detector so broad that every `__reset*`
    // hook lands in the baseline, and the baseline stops meaning anything.
    const shaped = new Set(allExports.filter((e) => e.handlerShaped).map((e) => e.name));
    for (const helper of ["__resetAIRateLimiter", "isRateLimitExempt", "zodErrorToFriendly"]) {
      expect(shaped, `${helper} is not a request handler`).not.toContain(helper);
    }
  });

  it("has no unmounted middleware outside the reviewed baseline", () => {
    const baseline = new Set(UNMOUNTED_MIDDLEWARE_BASELINE);
    const offenders = unreachable
      .map((e) => exportKey(e.file, e.name))
      .filter((key) => !baseline.has(key));

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `\n${offenders.length} exported middleware handler(s) are imported by NO production ` +
            `module under server/src:\n\n${offenders.map((o) => `  ${o}`).join("\n")}\n\n` +
            `An exported-but-unmounted guard is read as the behavioural standard while ` +
            `being subject to no request (#1083). Either mount it, or delete it — do not ` +
            `append to UNMOUNTED_MIDDLEWARE_BASELINE to silence this.\n`,
    ).toEqual([]);
  });

  it("has no baseline entry that is already reachable (the list may only shrink)", () => {
    const unreachableKeys = new Set(unreachable.map((e) => exportKey(e.file, e.name)));
    const stale = UNMOUNTED_MIDDLEWARE_BASELINE.filter((key) => !unreachableKeys.has(key));
    expect(
      stale,
      stale.length === 0
        ? ""
        : `\nThese baseline entries are no longer unmounted (or no longer exist). Delete ` +
            `them so the baseline keeps telling the truth:\n  ${stale.join("\n  ")}\n`,
    ).toEqual([]);
  });
});

describe("reachability is measured by import, not by text", () => {
  const mwDir = "/srv/src/middleware";

  it("counts a named import of a middleware module", () => {
    const { names } = collectMiddlewareImports(
      ["/srv/src/routes/x.ts"],
      mwDir,
      () => 'import { requireThing } from "../middleware/thing.js";',
    );
    expect(names.has("requireThing")).toBe(true);
  });

  it("counts a same-directory import between two middleware modules", () => {
    // `middleware/rate-limit.ts` importing `./cluster-rate-limit-store.js` is a
    // real importer; a specifier-substring check would miss it.
    const { names } = collectMiddlewareImports(
      ["/srv/src/middleware/rate-limit.ts"],
      mwDir,
      () => 'import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";',
    );
    expect(names.has("clusterRateLimitStore")).toBe(true);
  });

  it("unwraps aliased and type-only named imports", () => {
    const { names } = collectMiddlewareImports(
      ["/srv/src/routes/x.ts"],
      mwDir,
      () => 'import { type Role, requireRole as guard } from "../middleware/role.js";',
    );
    expect([...names].sort()).toEqual(["Role", "requireRole"]);
  });

  it("treats a wholesale module import as making every export reachable", () => {
    const { wholeModules } = collectMiddlewareImports(
      ["/srv/src/routes/x.ts"],
      mwDir,
      () => 'import * as mw from "../middleware/thing.js";',
    );
    expect(wholeModules.has("/srv/src/middleware/thing.ts")).toBe(true);
  });

  it("does NOT count a mention inside a comment", () => {
    // The #1083 failure mode in one assertion: this is exactly what
    // `lib/custom-agents/authz.ts` contained while the middleware was dead.
    const { names } = collectMiddlewareImports(
      ["/srv/src/lib/authz.ts"],
      mwDir,
      () => "// matching the existing requireWorkspaceAccess behaviour.",
    );
    expect(names.size).toBe(0);
  });

  it("ignores imports that resolve outside the middleware directory", () => {
    const { names } = collectMiddlewareImports(
      ["/srv/src/routes/x.ts"],
      mwDir,
      () => 'import { prisma } from "../lib/prisma.js";',
    );
    expect(names.size).toBe(0);
  });
});

describe("handler shape detector", () => {
  it("detects a RequestHandler-typed const", () => {
    const [only] = parseMiddlewareExports(
      "a.ts",
      "export const guard: RequestHandler = async (req, _res, next) => {};",
    );
    expect(only.handlerShaped).toBe(true);
  });

  it("detects a factory whose returned handler spans several lines", () => {
    // `requireProjectAccess` has no return-type annotation; the signature is
    // the only evidence, and it carries a trailing comma.
    const [only] = parseMiddlewareExports(
      "a.ts",
      [
        "export function requireThing(param = 'projectId') {",
        "  return function requireThingMiddleware(",
        "    req: Request,",
        "    _res: Response,",
        "    next: NextFunction,",
        "  ): void {};",
        "}",
      ].join("\n"),
    );
    expect(only.handlerShaped).toBe(true);
  });

  it("detects a four-argument error handler", () => {
    const [only] = parseMiddlewareExports(
      "a.ts",
      "export function errs(err: Error, req: Request, res: Response, _next: NextFunction) {}",
    );
    expect(only.handlerShaped).toBe(true);
  });

  it("does not treat a pure helper as a handler", () => {
    const [only] = parseMiddlewareExports(
      "a.ts",
      "export function scopeFilter(user: { role: string }): object { return {}; }",
    );
    expect(only.handlerShaped).toBe(false);
  });

  it("attributes a handler signature to the export that owns it", () => {
    const parsed = parseMiddlewareExports(
      "a.ts",
      [
        "export function pureHelper(x: string): string { return x; }",
        "export const guard: RequestHandler = (req, _res, next) => next();",
      ].join("\n"),
    );
    expect(parsed.map((p) => [p.name, p.handlerShaped])).toEqual([
      ["pureHelper", false],
      ["guard", true],
    ]);
  });
});
