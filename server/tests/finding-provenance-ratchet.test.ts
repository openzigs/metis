/**
 * Issue #1325 — CI ratchet for the `Finding` provenance invariant
 *
 *     derivation === 'extracted'  ⇒  confidence === 1.0
 *
 * WHY A RATCHET AND NOT A VALIDATION CALL (ADR 0010).
 *
 * The invariant was documented in three places as being enforced somewhere it
 * was not: `schema.prisma` and `docs/data-model.md` both cited a Zod refinement
 * on `createFindingSchema`, which has no runtime importer, and `data-model.md`
 * additionally claimed a "type-safety gate" — that `derivation` and
 * `confidence` are non-nullable so "TypeScript will refuse to compile a call
 * that omits them". Both columns carry a Prisma `@default(...)`, which makes
 * them OPTIONAL in `FindingCreateInput`; a create that omits both compiles
 * clean (measured on #1325 with a control error to prove `tsc` saw the file).
 *
 * Wiring `createFindingSchema` into the two known writers (option 1 in #1325)
 * would have bought nothing, because the writer that broke the rule is the one
 * that does not opt in. #1325 named "scan-finding materialisation" as a
 * HYPOTHETICAL third writer. It already existed — `materializeTriagedFinding`
 * has shipped since Epic #708 writing five columns `Finding` does not have, and
 * cannot persist a row at all (#1330). A per-call parse in the two writers that
 * were already correct would not have seen it. A sweep over CALL SITES does.
 *
 * WHAT THIS TEST CHECKS. Every Finding-delegate write in production code
 * (`server/src`, `server/scripts`, excluding `*.test.ts`) is classified from
 * its own source text, and must land in one of:
 *
 *   - `literal-safe`   — `derivation` is a string literal that is either not
 *                        `"extracted"`, or is `"extracted"` alongside a literal
 *                        confidence of exactly 1. Needs no registration.
 *   - `guarded`        — `derivation` is an expression, so the value is only
 *                        knowable at runtime. Must be registered in
 *                        {@link GUARDED_FINDING_WRITERS} naming the guard, and
 *                        that guard's behaviour is asserted separately below —
 *                        a registry entry is not a rubber stamp.
 *   - `defaulted`      — `derivation` is absent, so Prisma's `"inferred"`
 *                        default silently applies. Must be registered in
 *                        {@link DEFAULTED_FINDING_WRITERS}. Cannot violate the
 *                        invariant, but it is the shape #1330 hid inside, so a
 *                        new one is surfaced rather than absorbed.
 *   - `literal-violation` / `unclassified` — always red, never registrable.
 *
 * FAIL-CLOSED PROPERTIES (this repo has shipped fifteen gates that could not
 * fail — #1215 found eight in one audit; #1249/#1270/#1277 added more):
 *
 *   1. An empty or shrunken call-site list FAILS. Corpus floors, a named canary
 *      set and a per-scan-root contribution check are asserted before the
 *      headline check, so a moved file, a renamed delegate, a dropped scan root
 *      or an unreadable directory goes red instead of quiet.
 *   2. The classifier reads the real AST, not a hand-maintained inventory, so
 *      the check is not derived from the list it validates (#1249).
 *   3. A registry entry waives EXACTLY the site it names, and exactly as many
 *      call sites as it declares. Fewer means a stale entry; more means a
 *      second, unreviewed writer has INHERITED the waiver. Site keys carry the
 *      enclosing declaration so writers in different functions cannot share an
 *      entry, and the per-key count separates writers in the same function.
 *      (A file-scoped key shipped in the first cut of this gate and let a new
 *      unguarded writer in an already-registered file pass — the "third writer
 *      inherits no guard" risk #1325 was filed about, reproduced in review.)
 *   4. The classifier is exercised on synthetic sources for every branch,
 *      including the violating one and both delegate-evasion shapes, so the red
 *      path is proven without waiting for someone to commit a violation.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { FINDING_DERIVATIONS } from "@metis/shared";
import { resolveFindingProvenance } from "../src/lib/analysis/analysis-service.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
// `prisma` is in scope for `prisma/seed.ts`, which `package.json` wires as the
// Prisma seed command (`"prisma": { "seed": "tsx prisma/seed.ts" }`) — production
// code by any useful definition. A missing root throws ENOENT at module load,
// which is the fail-closed direction.
const SCAN_ROOTS = ["src", "scripts", "prisma"] as const;

/** Prisma delegate methods that can write a `derivation` / `confidence` pair. */
const WRITE_METHODS = new Set(["create", "createMany", "upsert", "update", "updateMany"]);

// ---------------------------------------------------------------------------
// Registries — both may only SHRINK.
// ---------------------------------------------------------------------------

/**
 * Writers whose `derivation` is an expression rather than a literal, reviewed
 * and accepted because a named guard makes `"extracted"` unreachable.
 *
 * `guard` is asserted behaviourally in "the registered guards actually uphold
 * the invariant" below. Adding an entry here without a matching behavioural
 * assertion is how a waiver list becomes a rubber stamp.
 */
const GUARDED_FINDING_WRITERS: readonly { site: string; count: number; guard: string }[] = [
  {
    // #1234 — coerces a model-authored `extracted` down to `inferred`, so the
    // mandatory-1.0 branch is unreachable from model output.
    site: "src/lib/analysis/analysis-service.ts :: persistAgentResult :: prisma.finding.create",
    count: 1,
    guard: "resolveFindingProvenance",
  },
];

/**
 * Writers that pass no `derivation` at all and inherit Prisma's `"inferred"`
 * default. Safe against THIS invariant; listed so the shape stays visible.
 *
 * DO NOT append here to silence a red test — pass the pair explicitly instead.
 */
const DEFAULTED_FINDING_WRITERS: readonly { site: string; count: number; why: string }[] = [
  // EMPTY — and that is a state this gate reaches honestly, not a state that
  // makes it vacuous. #1330 landed: `materializeTriagedFinding` now passes
  // `derivation: "inferred" satisfies …` as a literal, so it classifies as
  // `literal-safe` and needs no waiver. Emptiness cannot hide a regression
  // here: an unregistered `defaulted` site fails the headline check below, and
  // `registryDrift` is exercised in both directions on synthetic sites, so the
  // "empty registry ⇒ nothing to check ⇒ green" shape (#1215) does not apply.
];

// ---------------------------------------------------------------------------
// Classifier (pure — unit-tested on synthetic sources below).
// ---------------------------------------------------------------------------

export type FindingWriteKind =
  | "literal-safe"
  | "literal-violation"
  | "guarded"
  | "defaulted"
  | "unclassified";

export interface FindingWriteSite {
  /**
   * `<file> :: <enclosing> :: <receiver>.<method>` — identity for one call site.
   *
   * The enclosing declaration is part of the key deliberately. A key of only
   * file + receiver + method is shared by every same-shaped write in the file,
   * so ONE registry entry would waive a second, unreviewed writer added beside
   * it — the exact "third writer inherits no guard" risk #1325 was filed about.
   * The enclosing name separates writers in different functions; writers in the
   * SAME function are separated by the per-key COUNT each registry entry
   * declares. Line numbers are deliberately not in the key: they change under
   * every edit above the call and would make the registry churn.
   */
  key: string;
  file: string;
  line: number;
  kind: FindingWriteKind;
  /** Human-readable reason, surfaced in the failure message. */
  detail: string;
}

/**
 * True when `expr` names a Prisma `Finding` delegate.
 *
 * Two shapes matter, and a naive `.finding.create` text scan sees only the
 * first — which is exactly how #1330 stayed invisible:
 *
 *   - `prisma.finding` / `tx.finding`      — direct property access
 *   - `const d = (tx as ...).finding; d.create(...)` — access captured in a
 *     local first, so the call expression's receiver is a bare identifier.
 *
 *   - `prisma["finding"]`                  — element access with a literal key
 *
 * `scanFinding` is a DIFFERENT model and must not match; the property name is
 * compared exactly rather than by substring.
 */
function isFindingDelegateExpression(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr);
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text === "finding";
  if (ts.isElementAccessExpression(unwrapped)) {
    const key = unwrapExpression(unwrapped.argumentExpression);
    return ts.isStringLiteralLike(key) && key.text === "finding";
  }
  return false;
}

/**
 * The nearest named enclosing declarations of `node`, outermost first.
 *
 * Used to give each call site an identity that survives edits elsewhere in the
 * file but still distinguishes two writers in the same file. Falls back to
 * `<module>` for a top-level statement.
 */
function enclosingName(node: ts.Node): string {
  const parts: string[] = [];
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isClassDeclaration(cur)
    ) {
      if (cur.name && ts.isIdentifier(cur.name)) parts.unshift(cur.name.text);
    } else if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      parts.unshift(cur.parent.name.text);
    }
  }
  return parts.length > 0 ? parts.join(".") : "<module>";
}

/** Strip parentheses, `as` casts and non-null assertions. */
function unwrapExpression(expr: ts.Expression): ts.Expression {
  let cur = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

/**
 * Local names in `source` bound to a Finding delegate, in either shape:
 *
 *   - `const d = prisma.finding;`      — initialised from a delegate access
 *   - `const { finding } = prisma;`    — destructured, optionally renamed
 *
 * Aliases are file-scoped rather than block-scoped, which over-matches a
 * same-named parameter elsewhere in the file. That direction is deliberate: an
 * over-match is a red the author resolves, an under-match is a writer that
 * escapes (#1330 escaped a text scan exactly this way).
 */
function collectDelegateAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && isFindingDelegateExpression(node.initializer)) {
        aliases.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const sourceName = el.propertyName ?? el.name;
          const text =
            ts.isIdentifier(sourceName) || ts.isStringLiteral(sourceName) ? sourceName.text : "";
          if (text === "finding" && ts.isIdentifier(el.name)) aliases.add(el.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return aliases;
}

/** The object-literal payloads a write call carries (`data`, `create`, `update`). */
function payloadsOf(call: ts.CallExpression): ts.ObjectLiteralExpression[] {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return [];
  const out: ts.ObjectLiteralExpression[] = [];
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : "";
    if (name !== "data" && name !== "create" && name !== "update") continue;
    const value = unwrapExpression(prop.initializer);
    // `createMany` takes an array of rows; classify every row.
    if (ts.isArrayLiteralExpression(value)) {
      for (const el of value.elements) {
        const row = unwrapExpression(el as ts.Expression);
        if (ts.isObjectLiteralExpression(row)) out.push(row);
      }
    } else if (ts.isObjectLiteralExpression(value)) {
      out.push(value);
    }
  }
  return out;
}

/** The initializer for `key` in `obj`, or `undefined` when the key is absent. */
function propertyValue(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : "";
    if (name === key) return unwrapExpression(prop.initializer);
  }
  return undefined;
}

/** Classify one payload object against the invariant. */
function classifyPayload(payload: ts.ObjectLiteralExpression): {
  kind: FindingWriteKind;
  detail: string;
} {
  const derivation = propertyValue(payload, "derivation");
  const confidence = propertyValue(payload, "confidence");

  if (!derivation) {
    return {
      kind: "defaulted",
      detail: "no `derivation` key — Prisma's `inferred` default applies silently",
    };
  }

  if (!ts.isStringLiteralLike(derivation)) {
    return {
      kind: "guarded",
      detail: `derivation is the expression \`${derivation.getText()}\` — value unknown statically`,
    };
  }

  const value = derivation.text;
  if (!(FINDING_DERIVATIONS as readonly string[]).includes(value)) {
    return { kind: "literal-violation", detail: `derivation "${value}" is not a known derivation` };
  }
  if (value !== "extracted") {
    return { kind: "literal-safe", detail: `derivation "${value}" — invariant does not apply` };
  }

  // derivation === "extracted": confidence MUST be a literal 1.
  if (!confidence) {
    return {
      kind: "literal-violation",
      detail: 'derivation "extracted" with no `confidence` — the 0.7 default violates the rule',
    };
  }
  if (!ts.isNumericLiteral(confidence) || Number(confidence.text) !== 1) {
    return {
      kind: "literal-violation",
      detail: `derivation "extracted" with confidence \`${confidence.getText()}\` — must be literal 1.0`,
    };
  }
  return { kind: "literal-safe", detail: 'derivation "extracted" with confidence 1.0' };
}

/**
 * Every Finding-delegate write in one TypeScript source, classified.
 *
 * `file` is used verbatim in the site key, so callers pass a repo-relative
 * path.
 */
export function findFindingWriteSites(file: string, text: string): FindingWriteSite[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const aliases = collectDelegateAliases(source);
  const sites: FindingWriteSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text)) {
        const receiver = unwrapExpression(callee.expression);
        const viaDelegate = isFindingDelegateExpression(receiver);
        const viaAlias = ts.isIdentifier(receiver) && aliases.has(receiver.text);
        if (viaDelegate || viaAlias) {
          const key = `${file} :: ${enclosingName(node)} :: ${receiver.getText()}.${callee.name.text}`;
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const payloads = payloadsOf(node);
          if (payloads.length === 0) {
            sites.push({
              key,
              file,
              line,
              kind: "unclassified",
              detail:
                "no `data` / `create` / `update` object literal — payload not statically readable",
            });
          } else {
            for (const payload of payloads) {
              const { kind, detail } = classifyPayload(payload);
              sites.push({ key, file, line, kind, detail });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return sites;
}

// ---------------------------------------------------------------------------
// Live sweep over the tree.
// ---------------------------------------------------------------------------

/** Every production `.ts` under `dir`, recursively. Test files are excluded. */
function walkProduction(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkProduction(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const productionFiles = SCAN_ROOTS.flatMap((root) => walkProduction(join(SERVER_ROOT, root)));

/** `productionFiles` as repo-relative, forward-slashed paths — the site-key form. */
const scannedPaths = productionFiles.map((f) => relative(SERVER_ROOT, f).split("\\").join("/"));

const allSites = productionFiles.flatMap((file, i) =>
  findFindingWriteSites(scannedPaths[i], readFileSync(file, "utf8")),
);

/**
 * Registry entries that no longer waive exactly the call sites they declare.
 *
 * BOTH directions are failures, and each catches a distinct fail-open shape:
 *
 *   - FEWER live sites than declared — a stale entry that no longer describes
 *     the tree. A registry that outlives its subject stops meaning anything
 *     (#1249), so entries stay non-deletable-with-green.
 *   - MORE live sites than declared — a second, unreviewed writer of the same
 *     shape in the same function has INHERITED the waiver. This is the shape a
 *     file-scoped key had, where ONE entry silently covered every same-shaped
 *     write in the file. Only `guarded` and `defaulted` are registrable, and
 *     both are safe *only* because a human reviewed that one site; inheriting
 *     the waiver is exactly the "third writer inherits no guard" risk of #1325.
 *
 * Pure over `sites` so both directions are unit-tested below rather than only
 * reachable by committing a violation.
 */
export function registryDrift(
  sites: readonly FindingWriteSite[],
  kind: FindingWriteKind,
  registry: readonly { site: string; count: number }[],
): string[] {
  return registry
    .map((entry) => ({
      entry,
      live: sites.filter((s) => s.kind === kind && s.key === entry.site).length,
    }))
    .filter(({ entry, live }) => live !== entry.count)
    .map(({ entry, live }) =>
      live === 0
        ? `${entry.site} — declares ${entry.count}, matches NO live ${kind} call site (stale: delete it)`
        : `${entry.site} — declares ${entry.count}, found ${live} live ${kind} call site(s)`,
    );
}

const countMismatches = (
  kind: FindingWriteKind,
  registry: readonly { site: string; count: number }[],
): string[] => registryDrift(allSites, kind, registry);

describe("Finding provenance ratchet — corpus anchors", () => {
  it("scanned a plausible production corpus", () => {
    // A ratchet that silently scans nothing passes forever. Floors sit below
    // the measured corpus (700+ production files at the time of writing) with
    // headroom for deletions.
    expect(productionFiles.length).toBeGreaterThanOrEqual(400);
  });

  it("found the Finding write sites it exists to police", () => {
    // Measured: 7 call sites across 5 files. The floor sits AT the measured
    // count, not below it, so deleting any one site is red rather than silent.
    // If the delegate is renamed, a file moves, or the AST walk stops matching,
    // this goes red BEFORE the headline assertion goes quiet for the wrong
    // reason.
    expect(allSites.length).toBeGreaterThanOrEqual(7);
  });

  it("sees every file known to write findings", () => {
    const files = new Set(allSites.map((s) => s.file));
    for (const expected of [
      "src/lib/analysis/analysis-service.ts",
      "src/lib/code-graph/ingest.ts",
      "src/lib/scanner/prisma-adapter.ts",
      "scripts/e2e-seed-clarify-loop.ts",
      "scripts/e2e-seed-analysis-grounding.ts",
    ]) {
      expect(files, `${expected} should contain a Finding write site`).toContain(expected);
    }
  });

  it("scanned every declared root, and every root contributed files", () => {
    // A root that contributes nothing is a root that policies nothing. Without
    // this, a root could be deleted from SCAN_ROOTS with the suite still green.
    for (const root of SCAN_ROOTS) {
      const fromRoot = scannedPaths.filter((f) => f.startsWith(`${root}/`));
      expect(fromRoot.length, `SCAN_ROOTS entry "${root}" contributed no files`).toBeGreaterThan(0);
    }
  });

  it("scanned the Prisma seed script that the Prisma config wires as production code", async () => {
    // `prisma.config.ts` declares `migrations.seed`, so the seed is production code
    // that writes rows. It sat OUTSIDE the sweep until #1325's review. The path is
    // read from the config rather than hard-coded, so renaming the seed cannot
    // quietly un-policy it.
    //
    // #1385 moved that declaration: it used to be `"prisma": { "seed": ... }` in
    // `server/package.json`, which Prisma 7 stopped reading — leaving `pnpm db:seed`
    // a no-op that exited 0. This test read the dead location and passed throughout,
    // which is worth noting: reading a config key proves the key exists, not that
    // anything consumes it. `tests/prisma-quickstart-config.test.ts` is the arm that
    // executes the seed.
    const config = (await import("../prisma.config.js")).default as {
      migrations?: { seed?: string };
    };
    const seedCommand = config.migrations?.seed;
    expect(seedCommand, "prisma.config.ts declares no migrations.seed command").toBeTruthy();
    const seedPath = /(\S+\.ts)\b/.exec(seedCommand ?? "")?.[1];
    expect(seedPath, `no .ts path in migrations.seed command "${seedCommand}"`).toBeTruthy();
    expect(scannedPaths).toContain(seedPath);
  });

  it("does not mistake the ScanFinding delegate for the Finding delegate", () => {
    // `prisma.scanFinding.create` is a different model with no provenance
    // columns. A substring match on "finding" would sweep it in and the
    // registries would fill with noise until they meant nothing.
    const scanFindingSites = allSites.filter((s) => /\bscanFinding\b/.test(s.key));
    expect(scanFindingSites.map((s) => s.key)).toEqual([]);
  });
});

describe("Finding provenance ratchet — the invariant", () => {
  it("has no call site that violates derivation='extracted' ⇒ confidence=1.0", () => {
    const offenders = allSites.filter(
      (s) => s.kind === "literal-violation" || s.kind === "unclassified",
    );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `\n${offenders.length} Finding write site(s) break the provenance invariant:\n\n` +
            offenders.map((o) => `  ${o.key} (line ${o.line})\n    ${o.detail}`).join("\n") +
            `\n\nThere is no waiver for this. Nothing validates the rule at runtime ` +
            `(ADR 0010): pass a literal derivation, and confidence exactly 1.0 when it ` +
            `is "extracted".\n`,
    ).toEqual([]);
  });

  it("has no expression-derivation writer outside the reviewed guard registry", () => {
    const registered = new Set(GUARDED_FINDING_WRITERS.map((e) => e.site));
    const offenders = allSites
      .filter((s) => s.kind === "guarded" && !registered.has(s.key))
      .map((s) => `${s.key} (line ${s.line}) — ${s.detail}`);
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `\nFinding write site(s) compute \`derivation\` at runtime with no reviewed ` +
            `guard:\n\n${offenders.map((o) => `  ${o}`).join("\n")}\n\nEither pass a literal, ` +
            `or register the site in GUARDED_FINDING_WRITERS and add a behavioural ` +
            `assertion for the guard below.\n`,
    ).toEqual([]);
  });

  it("has no derivation-omitting writer outside the reviewed default registry", () => {
    const registered = new Set(DEFAULTED_FINDING_WRITERS.map((e) => e.site));
    const offenders = allSites
      .filter((s) => s.kind === "defaulted" && !registered.has(s.key))
      .map((s) => `${s.key} (line ${s.line})`);
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `\nFinding write site(s) omit \`derivation\` and inherit Prisma's default:\n\n` +
            `${offenders.map((o) => `  ${o}`).join("\n")}\n\nPass \`derivation\` and ` +
            `\`confidence\` explicitly. Prisma's defaults make both OPTIONAL in ` +
            `FindingCreateInput, so tsc will NOT catch the omission (#1325).\n`,
    ).toEqual([]);
  });
});

describe("Finding provenance ratchet — a registry entry waives exactly one site", () => {
  const remedy =
    `\n\nAn entry waives the call sites it names and counts, not a file. If this is a ` +
    `NEW writer, review it on its own merits and give it its own entry (or pass a ` +
    `literal \`derivation\`); do not raise a count to absorb it. If the entry is stale, ` +
    `delete it.\n`;

  it("has no guard-registry entry whose live call-site count has drifted", () => {
    const drift = countMismatches("guarded", GUARDED_FINDING_WRITERS);
    expect(
      drift,
      drift.length === 0
        ? ""
        : `\nGUARDED_FINDING_WRITERS no longer describes the tree:\n\n` +
            `${drift.map((d) => `  ${d}`).join("\n")}${remedy}`,
    ).toEqual([]);
  });

  it("has no default-registry entry whose live call-site count has drifted", () => {
    const drift = countMismatches("defaulted", DEFAULTED_FINDING_WRITERS);
    expect(
      drift,
      drift.length === 0
        ? ""
        : `\nDEFAULTED_FINDING_WRITERS no longer describes the tree:\n\n` +
            `${drift.map((d) => `  ${d}`).join("\n")}${remedy}`,
    ).toEqual([]);
  });

  it("registers no key twice, so one site cannot be waived by two entries", () => {
    // Two entries sharing a key would each see the same live sites and both
    // could be satisfied by a count that describes neither.
    const keys = [
      ...GUARDED_FINDING_WRITERS.map((e) => e.site),
      ...DEFAULTED_FINDING_WRITERS.map((e) => e.site),
    ];
    expect(keys).toEqual([...new Set(keys)]);
  });
});

describe("Finding provenance ratchet — the registered guards actually uphold the invariant", () => {
  it("resolveFindingProvenance never returns derivation='extracted'", () => {
    // The registry entry for analysis-service.ts is only worth its waiver if
    // this holds. Without this assertion the entry is a rubber stamp.
    for (const candidate of [...FINDING_DERIVATIONS, "EXTRACTED", "", null, undefined, 42, {}]) {
      const out = resolveFindingProvenance({ derivation: candidate, confidence: 0.7 });
      expect(out.derivation, `input ${JSON.stringify(candidate)}`).not.toBe("extracted");
    }
  });

  it("every guard named in the registry is the one asserted above", () => {
    // Guards the loop above from silently covering nothing if a future entry
    // names a different function.
    expect([...new Set(GUARDED_FINDING_WRITERS.map((e) => e.guard))]).toEqual([
      "resolveFindingProvenance",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Classifier unit tests — every branch, on synthetic sources.
// ---------------------------------------------------------------------------

describe("classifier: detection", () => {
  it("finds a direct prisma.finding.create", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      'await prisma.finding.create({ data: { derivation: "inferred", confidence: 0.7 } });',
    );
    expect(sites.map((s) => [s.key, s.kind])).toEqual([
      ["a.ts :: <module> :: prisma.finding.create", "literal-safe"],
    ]);
  });

  it("finds a transaction-client write", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      'await tx.finding.create({ data: { derivation: "inferred", confidence: 0.5 } });',
    );
    expect(sites.map((s) => s.kind)).toEqual(["literal-safe"]);
  });

  it("finds a write through a delegate captured in a local first", () => {
    // The #1330 shape. A `.finding.create` text scan finds NOTHING here.
    const source = [
      "const findingDelegate = (tx as unknown as { finding?: D }).finding;",
      "await findingDelegate.create({ data: { title: 'x' } });",
    ].join("\n");
    expect(/\.finding\.create/.test(source)).toBe(false); // a naive scan misses it
    const sites = findFindingWriteSites("a.ts", source);
    expect(sites.map((s) => s.kind)).toEqual(["defaulted"]);
  });

  it("finds a write through a delegate destructured off the client", () => {
    // `const { finding } = prisma` reaches the same delegate with no property
    // access left at the call site for a naive scan to match.
    const sites = findFindingWriteSites(
      "a.ts",
      [
        "const { finding } = prisma;",
        'await finding.create({ data: { derivation: "extracted", confidence: 0.3 } });',
      ].join("\n"),
    );
    expect(sites.map((s) => s.kind)).toEqual(["literal-violation"]);
  });

  it("finds a write through a RENAMED destructured delegate", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      [
        "const { finding: d } = prisma;",
        'await d.create({ data: { derivation: "extracted", confidence: 0.3 } });',
      ].join("\n"),
    );
    expect(sites.map((s) => s.kind)).toEqual(["literal-violation"]);
  });

  it("finds a write through element access on the client", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      'await prisma["finding"].create({ data: { derivation: "extracted", confidence: 0.3 } });',
    );
    expect(sites.map((s) => s.kind)).toEqual(["literal-violation"]);
  });

  it("does NOT match element access naming a different model", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      'await prisma["scanFinding"].create({ data: { severity: "high" } });',
    );
    expect(sites).toEqual([]);
  });

  it("does NOT match the ScanFinding delegate", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      'await prisma.scanFinding.create({ data: { severity: "high" } });',
    );
    expect(sites).toEqual([]);
  });

  it("does NOT match a mention inside a comment or a string", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      [
        "// every prisma.finding.create({ data: { derivation: 'extracted' } }) must pass 1.0",
        "const doc = \"prisma.finding.create({ data: { derivation: 'extracted' } })\";",
      ].join("\n"),
    );
    expect(sites).toEqual([]);
  });

  it("does NOT match a read on the Finding delegate", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      "await prisma.finding.findFirst({ where: { id } });",
    );
    expect(sites).toEqual([]);
  });

  it("classifies every row of a createMany array", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      "await prisma.finding.createMany({ data: [" +
        '{ derivation: "inferred", confidence: 0.7 },' +
        '{ derivation: "extracted", confidence: 0.7 }' +
        "] });",
    );
    expect(sites.map((s) => s.kind)).toEqual(["literal-safe", "literal-violation"]);
  });

  it("classifies both halves of an upsert", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      "await prisma.finding.upsert({ where: { id }," +
        ' create: { derivation: "extracted", confidence: 1.0 },' +
        ' update: { derivation: "extracted", confidence: 0.9 } });',
    );
    expect(sites.map((s) => s.kind)).toEqual(["literal-safe", "literal-violation"]);
  });

  it("sees through a non-null assertion on the delegate", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      'await tx.finding!.create({ data: { derivation: "extracted", confidence: 0.4 } });',
    );
    expect(sites.map((s) => s.kind)).toEqual(["literal-violation"]);
  });

  it("sees through a `satisfies` expression on the delegate", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      '(prisma.finding satisfies Delegate).create({ data: { derivation: "extracted" } });',
    );
    expect(sites.map((s) => s.kind)).toEqual(["literal-violation"]);
  });

  it("policies update as well as create — provenance can be rewritten after insert", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      'await prisma.finding.update({ where: { id }, data: { derivation: "extracted", confidence: 0.2 } });',
    );
    expect(sites.map((s) => s.kind)).toEqual(["literal-violation"]);
  });

  it("flags a write whose payload is not a readable object literal", () => {
    const sites = findFindingWriteSites("a.ts", "await prisma.finding.create(buildPayload());");
    expect(sites.map((s) => s.kind)).toEqual(["unclassified"]);
  });
});

describe("registryDrift: a waiver covers exactly what it declares", () => {
  const site = (key: string, kind: FindingWriteKind): FindingWriteSite => ({
    key,
    file: "a.ts",
    line: 1,
    kind,
    detail: "",
  });
  const KEY = "a.ts :: persist :: prisma.finding.create";
  const registry = [{ site: KEY, count: 1 }];

  it("is silent when the declared count matches", () => {
    expect(registryDrift([site(KEY, "guarded")], "guarded", registry)).toEqual([]);
  });

  it("FAILS when the entry matches no live site (stale waiver)", () => {
    const drift = registryDrift([], "guarded", registry);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("matches NO live guarded call site");
  });

  it("FAILS when a SECOND site inherits the waiver (the #1325 fail-open shape)", () => {
    // Same key, same kind, same file — under a file-scoped key with no count
    // this second, unreviewed writer was waived by the first one's entry.
    const drift = registryDrift([site(KEY, "guarded"), site(KEY, "guarded")], "guarded", registry);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("declares 1, found 2 live guarded call site(s)");
  });

  it("does not count a site of a different kind toward the waiver", () => {
    // A `defaulted` entry must not be satisfied by a `guarded` site at the same
    // key, or a writer could change shape without review.
    const drift = registryDrift([site(KEY, "guarded")], "defaulted", registry);
    expect(drift[0]).toContain("matches NO live defaulted call site");
  });

  it("does not count a site at a different key toward the waiver", () => {
    const drift = registryDrift(
      [site("a.ts :: other :: prisma.finding.create", "guarded")],
      "guarded",
      registry,
    );
    expect(drift).toHaveLength(1);
  });
});

describe("classifier: site identity", () => {
  // The fail-open shape a file-scoped key had: one registry entry waived every
  // same-shaped write in the file, so a second unreviewed writer inherited the
  // waiver. Keys must separate writers; counts must separate the rest.

  it("gives two writers in DIFFERENT functions different keys", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      [
        "async function reviewed() {",
        "  await prisma.finding.create({ data: { derivation: d, confidence: c } });",
        "}",
        "async function sneaked() {",
        "  await prisma.finding.create({ data: { derivation: d, confidence: c } });",
        "}",
      ].join("\n"),
    );
    expect(sites.map((s) => s.key)).toEqual([
      "a.ts :: reviewed :: prisma.finding.create",
      "a.ts :: sneaked :: prisma.finding.create",
    ]);
  });

  it("names an arrow function bound to a const", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      "const persist = async () => { await prisma.finding.create({ data: { derivation: d } }); };",
    );
    expect(sites.map((s) => s.key)).toEqual(["a.ts :: persist :: prisma.finding.create"]);
  });

  it("qualifies a method with its class", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      "class Repo { async save() { await prisma.finding.create({ data: { derivation: d } }); } }",
    );
    expect(sites.map((s) => s.key)).toEqual(["a.ts :: Repo.save :: prisma.finding.create"]);
  });

  it("names a top-level write `<module>` rather than dropping the segment", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      "await prisma.finding.create({ data: { derivation: d } });",
    );
    expect(sites.map((s) => s.key)).toEqual(["a.ts :: <module> :: prisma.finding.create"]);
  });

  it("keeps the SAME key for two writers in one function, so the count separates them", () => {
    const sites = findFindingWriteSites(
      "a.ts",
      [
        "async function persist() {",
        "  await prisma.finding.create({ data: { derivation: d } });",
        "  await prisma.finding.create({ data: { derivation: d } });",
        "}",
      ].join("\n"),
    );
    expect(new Set(sites.map((s) => s.key)).size).toBe(1);
    expect(sites.length).toBe(2);
  });

  it("does not move a key when unrelated lines are inserted above it", () => {
    const write = "function f() { prisma.finding.create({ data: { derivation: d } }); }";
    const before = findFindingWriteSites("a.ts", write);
    const after = findFindingWriteSites("a.ts", `const noise = 1;\nconst more = 2;\n${write}`);
    expect(after[0].key).toBe(before[0].key);
    expect(after[0].line).not.toBe(before[0].line);
  });
});

describe("classifier: the invariant", () => {
  const create = (body: string) =>
    findFindingWriteSites("a.ts", `prisma.finding.create({ data: { ${body} } });`)[0];

  it("passes extracted with confidence 1.0", () => {
    expect(create('derivation: "extracted", confidence: 1.0').kind).toBe("literal-safe");
  });

  it("passes extracted with confidence written as 1", () => {
    expect(create('derivation: "extracted", confidence: 1').kind).toBe("literal-safe");
  });

  it("FAILS extracted with a confidence below 1.0", () => {
    const site = create('derivation: "extracted", confidence: 0.99');
    expect(site.kind).toBe("literal-violation");
    expect(site.detail).toContain("must be literal 1.0");
  });

  it("FAILS extracted with no confidence at all (the 0.7 default violates it)", () => {
    const site = create('derivation: "extracted"');
    expect(site.kind).toBe("literal-violation");
    expect(site.detail).toContain("0.7 default");
  });

  it("FAILS extracted with a confidence the reader cannot evaluate", () => {
    // `confidence: someVar` could be anything; "extracted" mandates a literal.
    expect(create('derivation: "extracted", confidence: computed').kind).toBe("literal-violation");
  });

  it("FAILS a derivation outside the enum", () => {
    expect(create('derivation: "derived", confidence: 1.0').kind).toBe("literal-violation");
  });

  it("allows inferred at any confidence", () => {
    expect(create('derivation: "inferred", confidence: 0.31').kind).toBe("literal-safe");
  });

  it("allows ambiguous at any confidence", () => {
    expect(create('derivation: "ambiguous", confidence: 0.2').kind).toBe("literal-safe");
  });

  it("marks an expression derivation as guarded, not safe", () => {
    expect(
      create("derivation: provenance.derivation, confidence: provenance.confidence").kind,
    ).toBe("guarded");
  });

  it("marks a missing derivation as defaulted, not safe", () => {
    expect(create("confidence: 1.0").kind).toBe("defaulted");
  });
});
