/**
 * #1268 — the redaction sinks are a **registry**, not a habit.
 *
 * Three modules in `server/src` declare a credential-shaped key denylist. Each
 * had its own copy of `/token/i`, so each independently blanked every token
 * count, and `custom-agents/invocation-audit.ts` renamed its fields to dodge
 * one of them rather than the guard being fixed. #1263 repaired the logger;
 * this file makes the set closed:
 *
 *   1. **No fourth copy.** Every file declaring such a denylist must be one of
 *      the three registered here *and* carry a recognised
 *      `REDACTION_SINK_POLICY:` marker. A new sink must register and choose.
 *   2. **No unclassified count.** Every `/token/i` metadata key reaching a real
 *      `audit({...})` call in `server/src` is re-derived from disk and must be
 *      either an enumerated count or a named credential.
 *   3. **The sandbox opt-out stays evidence-based.** The sandbox sink declines
 *      the exemption because no count reaches it. That premise is re-checked
 *      here, so if one ever does the next person decides on evidence.
 *
 * Decision and per-sink reasoning: `docs/decisions/0008-redaction-sinks.md`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankComments } from "./helpers/source-scan.js";
import { tokenCountMetaKeys } from "../src/lib/logger.js";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** The three registered sinks and the policy each declares in-file. */
const REGISTERED_SINKS: ReadonlyMap<string, string> = new Map([
  ["lib/logger.ts", "exempt-token-counts"],
  ["lib/audit/audit-service.ts", "exempt-token-counts"],
  ["lib/sandbox/audit/redact.ts", "no-token-count-exemption"],
]);

const RECOGNISED_POLICIES = new Set(["exempt-token-counts", "no-token-count-exemption"]);

/**
 * #85 — the second axis: whether a sink serialises a thrown `Error`.
 *
 * #68 made the logger serialise `name` / `message` / `stack` / `cause`, and #85
 * added an aggregate's `errors`. The same `Object.entries` rebuild is in both
 * PERSISTING sinks, where the answer is the opposite one — a stack in a retained
 * compliance row is a cost, not a feature — so the divergence is recorded per
 * sink rather than left looking like an unfixed copy of #68.
 * `docs/decisions/0016-error-serialisation-in-the-persisting-sinks.md`.
 */
const REGISTERED_ERROR_POLICIES: ReadonlyMap<string, string> = new Map([
  ["lib/logger.ts", "serialise-errors"],
  ["lib/audit/audit-service.ts", "reduce-at-call-site"],
  ["lib/sandbox/audit/redact.ts", "reduce-at-call-site"],
]);

const RECOGNISED_ERROR_POLICIES = new Set(["serialise-errors", "reduce-at-call-site"]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collectSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A regex literal in array-member position — directly after a `[` or a `,`.
 *
 * **Deliberately not anchored to a line.** The first draft required each member
 * to occupy a whole line ending in a comma, which is only how Prettier formats
 * an array too long for one line: `const P = [/token/i, /secret/i, /password/i];`
 * is 66 characters, inside the repo's `printWidth` of 100, so it stays on one
 * line and the whole gate silently found nothing — a fail-open in the very test
 * written to close one. `server/src/lib/analysis/requirement-verdict.ts` already
 * carries a single-line regex array, so the shape is not hypothetical.
 */
const REGEX_LIST_MEMBER = /(?<=[[,]\s*)(\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)/g;

const CREDENTIAL_SHAPED =
  /token|secret|password|passwd|authorization|credential|api[-_]?key|private[-_]?key|cookie/i;

/** Files declaring a credential-shaped key denylist, relative to `server/src`. */
function discoverSinkFiles(): string[] {
  const found: string[] = [];
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const src = blankComments(readFileSync(file, "utf8"));
    const members = [...src.matchAll(REGEX_LIST_MEMBER)].map((m) => m[1]);
    if (members.length < 3) continue;
    if (!members.some((rx) => CREDENTIAL_SHAPED.test(rx))) continue;
    found.push(path.relative(SRC_ROOT, file).split(path.sep).join("/"));
  }
  return found.sort();
}

function policyOf(relPath: string): string | null {
  const src = readFileSync(path.join(SRC_ROOT, relPath), "utf8");
  const m = src.match(/REDACTION_SINK_POLICY:\s*([a-z-]+)/);
  return m ? m[1] : null;
}

function errorPolicyOf(relPath: string): string | null {
  const src = readFileSync(path.join(SRC_ROOT, relPath), "utf8");
  const m = src.match(/ERROR_SERIALISATION_POLICY:\s*([a-z-]+)/);
  return m ? m[1] : null;
}

describe("redaction sinks — the registry is closed (#1268)", () => {
  const discovered = discoverSinkFiles();

  it("finds the declarations at all", () => {
    // Anti-vacuity: a scanner that silently stops matching passes every
    // assertion below. There were exactly three when #1268 landed.
    expect(
      discovered.length,
      "the source scan found no credential-shaped key denylists — the scanner is broken, not the repo",
    ).toBeGreaterThanOrEqual(3);
  });

  it("finds no denylist outside the registered sinks", () => {
    const unregistered = discovered.filter((f) => !REGISTERED_SINKS.has(f));
    expect(
      unregistered,
      "a fourth redaction list was added. Register it in docs/decisions/0008-redaction-sinks.md " +
        "and in REGISTERED_SINKS here, declaring whether it consults isTokenCountExempt — " +
        "copying a list is how all three ended up blanking every token count.",
    ).toEqual([]);
  });

  it("still finds every registered sink where it was registered", () => {
    // The other direction: a sink that is deleted, renamed or quietly stripped
    // of its denylist must fail too, not silently satisfy the check above.
    const missing = [...REGISTERED_SINKS.keys()].filter((f) => !discovered.includes(f));
    expect(missing, "a registered sink no longer declares a denylist").toEqual([]);
  });

  it("requires each registered sink to declare a recognised policy in-file", () => {
    for (const [file, expected] of REGISTERED_SINKS) {
      const policy = policyOf(file);
      expect(policy, `${file} is missing its REDACTION_SINK_POLICY marker`).not.toBeNull();
      expect(RECOGNISED_POLICIES.has(policy as string), `${file}: unknown policy ${policy}`).toBe(
        true,
      );
      expect(policy, `${file} declares a policy the registry does not expect`).toBe(expected);
    }
  });

  it("requires each registered sink to declare its error-serialisation policy too (#85)", () => {
    for (const [file, expected] of REGISTERED_ERROR_POLICIES) {
      const policy = errorPolicyOf(file);
      expect(
        policy,
        `${file} is missing its ERROR_SERIALISATION_POLICY marker. An Error reaching a sink that ` +
          `rebuilds objects from Object.entries() serialises as {} — #68's defect. Whether that is ` +
          `a bug or the policy is per-sink; declare which. ` +
          `docs/decisions/0016-error-serialisation-in-the-persisting-sinks.md`,
      ).not.toBeNull();
      expect(
        RECOGNISED_ERROR_POLICIES.has(policy as string),
        `${file}: unknown error policy ${policy}`,
      ).toBe(true);
      expect(policy, `${file} declares an error policy the registry does not expect`).toBe(
        expected,
      );
    }
  });

  it("registers the same set of files on both axes", () => {
    // A sink added to one map and not the other would be unchecked on that axis
    // while every assertion above still passed.
    expect([...REGISTERED_ERROR_POLICIES.keys()].sort()).toEqual(
      [...REGISTERED_SINKS.keys()].sort(),
    );
  });
});

// ── The audit sink's own keys ──────────────────────────────────────────────

/**
 * `/token/i` keys that reach a real `audit({...})` call and are **not** counts.
 * Empty today — the audit sink carries spend accounting, not credentials — but
 * the slot exists so the next one gets a name and a reason instead of a rename.
 */
const AUDIT_CLASSIFIED_CREDENTIAL_KEYS = new Set<string>();

/** Entry points that funnel through `audit-service.ts`'s redactor. */
const AUDIT_CALL =
  /(?:\baudit|\bauditInvocation|\brecordAndFlush|\bbuildAuditLogData|ports\.audit)\s*\(/g;

/** Slice out a balanced call expression starting at the `(` of a call. */
function sliceCall(src: string, openIdx: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}

/** Object keys appearing inside a call expression: `k:`, `"k":` and shorthand. */
function metaKeysOf(call: string): string[] {
  const keys = new Set<string>();
  for (const m of call.matchAll(/(?:^|[{,\s])["'`]?([A-Za-z_$][\w$]*)["'`]?\s*:/g)) keys.add(m[1]);
  for (const m of call.matchAll(/(?:[{,]\s*)([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) keys.add(m[1]);
  return [...keys];
}

function scanKeysAt(root: string, callRx: RegExp): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of collectSourceFiles(root)) {
    // Blank comments first: an apostrophe in prose otherwise derails the slicer.
    const src = blankComments(readFileSync(file, "utf8"));
    callRx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = callRx.exec(src)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      for (const key of metaKeysOf(sliceCall(src, openIdx))) {
        const line = src.slice(0, m.index).split("\n").length;
        const where = `${path.relative(SRC_ROOT, file).split(path.sep).join("/")}:${line}`;
        found.set(key, [...(found.get(key) ?? []), where]);
      }
    }
  }
  return found;
}

describe("audit sink — every /token/i key it persists is classified (#1268)", () => {
  const discovered = new Map(
    [...scanKeysAt(SRC_ROOT, AUDIT_CALL)].filter(([key]) => /token/i.test(key)),
  );
  const allowlist = tokenCountMetaKeys();
  const normalize = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

  it("finds the token-shaped audit keys at all", () => {
    // Anti-vacuity — 14 when #1268 landed.
    expect(
      discovered.size,
      "the source scan found almost no /token/i audit keys — the scanner is broken, not the repo",
    ).toBeGreaterThanOrEqual(10);
  });

  it("classifies each one as a count or as a credential", () => {
    const unclassified: string[] = [];
    for (const [key, sites] of discovered) {
      const isCount = allowlist.has(normalize(key));
      const isCredential = AUDIT_CLASSIFIED_CREDENTIAL_KEYS.has(key);
      if (isCount === isCredential) unclassified.push(`${key} (${sites.join(", ")})`);
    }
    expect(
      unclassified,
      "classify each key: add a count to TOKEN_COUNT_META_KEYS in logger.ts, or a " +
        "credential to AUDIT_CLASSIFIED_CREDENTIAL_KEYS here with a reason. Do NOT " +
        "rename the field to dodge the guard — that is the #1268 defect.",
    ).toEqual([]);
  });

  it("keeps every key classified as a credential out of the count allowlist", () => {
    for (const key of AUDIT_CLASSIFIED_CREDENTIAL_KEYS) {
      expect(allowlist.has(normalize(key)), `${key} is both a credential and a count`).toBe(false);
    }
  });

  it("no audit call still carries a name renamed around the guard", () => {
    // #1268's workaround shape. `usage` is not credential-shaped, so nothing
    // else would ever notice these came back.
    const all = scanKeysAt(SRC_ROOT, AUDIT_CALL);
    for (const dodged of ["promptUsage", "completionUsage", "totalUsage"]) {
      expect(all.has(dodged), `${dodged} is a rename around /token/i — use the *Tokens name`).toBe(
        false,
      );
    }
  });
});

// ── The sandbox sink's own keys ────────────────────────────────────────────

const SANDBOX_ROOT = path.join(SRC_ROOT, "lib/sandbox");
const SANDBOX_EMIT = /emitter\.emit\s*\(/g;

describe("sandbox sink — the no-exemption premise still holds (#1268)", () => {
  const discovered = scanKeysAt(SANDBOX_ROOT, SANDBOX_EMIT);

  it("finds the sandbox payload keys at all", () => {
    // Anti-vacuity — 24 distinct keys across the four providers when #1268
    // landed (bytes, command, costMicroUsd, exitCode, path, timeoutMs, …).
    expect(
      discovered.size,
      "the sandbox emit scan found almost nothing — the scanner is broken, not the repo",
    ).toBeGreaterThanOrEqual(15);
  });

  it("carries no token count, which is why the sink declines the exemption", () => {
    const counts = [...discovered].filter(([key]) => /token/i.test(key));
    expect(
      counts.map(([key, sites]) => `${key} (${sites.join(", ")})`),
      "a token-shaped key now reaches the sandbox audit sink, and that sink redacts it. " +
        "Its no-token-count-exemption policy was chosen because no count reached it — " +
        "revisit docs/decisions/0008-redaction-sinks.md on this evidence, do not rename the field.",
    ).toEqual([]);
  });
});

// ── The persisting sinks do not serialise Errors (#85) ─────────────────────

/**
 * #85 — the premise behind `reduce-at-call-site`, re-checked from source.
 *
 * Both persisting sinks rebuild every object from `Object.entries(...)`, so an
 * `Error` handed to either one persists as `{}` plus whatever own *enumerable*
 * properties it carries. The decision not to fix that the way #68 fixed the
 * logger rests on one fact: **no call site hands either sink an Error.** Every
 * `audit({...})` reduces to `.message` or `.code` at the boundary, which is
 * where the judgement about how much of a failure a retained compliance record
 * should keep belongs.
 *
 * That is a claim about the source, so it is read off the source. If a call site
 * ever does pass a bare error, this fails and the next person re-decides on
 * evidence — the construction ADR 0008 used for the sandbox token-count opt-out.
 */
const ERROR_VALUED: ReadonlyArray<RegExp> = [
  // `{ key: err }` — a bare error identifier in value position, unreduced.
  /:\s*(?:err|error|e|ex|exc|exception|cause|aggregate|aggregateError)\s*(?=[,}])/,
  // `{ err }` shorthand.
  /[{,]\s*(?:err|error|ex|exc|exception|cause)\s*(?=[,}])/,
  // A freshly constructed error handed straight in.
  /:\s*new\s+\w*Error\s*\(/,
];

/** Every call expression matching `callRx`, with a `file:line` for each. */
function scanCallsAt(root: string, callRx: RegExp): Array<{ where: string; call: string }> {
  const out: Array<{ where: string; call: string }> = [];
  for (const file of collectSourceFiles(root)) {
    const src = blankComments(readFileSync(file, "utf8"));
    callRx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = callRx.exec(src)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const line = src.slice(0, m.index).split("\n").length;
      out.push({
        where: `${path.relative(SRC_ROOT, file).split(path.sep).join("/")}:${line}`,
        call: sliceCall(src, openIdx),
      });
    }
  }
  return out;
}

function errorValuedSites(calls: Array<{ where: string; call: string }>): string[] {
  return calls.filter(({ call }) => ERROR_VALUED.some((rx) => rx.test(call))).map((c) => c.where);
}

describe("persisting sinks — nothing hands them an un-reduced Error (#85)", () => {
  const auditCalls = scanCallsAt(SRC_ROOT, AUDIT_CALL);
  const sandboxCalls = scanCallsAt(SANDBOX_ROOT, SANDBOX_EMIT);

  it("finds the call sites at all", () => {
    // Anti-vacuity, both scans. A detector that matched nothing would satisfy
    // every assertion below — the failure shape this repo keeps re-finding.
    expect(auditCalls.length, "the audit call scan found nothing").toBeGreaterThanOrEqual(30);
    expect(sandboxCalls.length, "the sandbox emit scan found nothing").toBeGreaterThanOrEqual(10);
  });

  it("the detector fires on a call site that would leak one", () => {
    // Positive control for the patterns themselves, independent of the repo's
    // current state: without it, deleting a pattern reads as "premise holds".
    const planted = [
      { where: "planted.ts:1", call: "({ action: 'x', metadata: { error: err } })" },
      { where: "planted.ts:2", call: "({ action: 'x', metadata: { err } })" },
      { where: "planted.ts:3", call: "({ action: 'x', metadata: { cause: new Error('boom') } })" },
    ];
    expect(errorValuedSites(planted)).toEqual(["planted.ts:1", "planted.ts:2", "planted.ts:3"]);
    // …and not on the reduced forms every real call site uses.
    expect(
      errorValuedSites([
        { where: "ok.ts:1", call: "({ metadata: { error: (err as Error).message } })" },
        { where: "ok.ts:2", call: "({ metadata: { errorMessage: message, code: ce.code } })" },
        { where: "ok.ts:3", call: "({ metadata: { status: 'error', error: summary } })" },
      ]),
    ).toEqual([]);
  });

  it("no audit call site passes a bare error", () => {
    expect(
      errorValuedSites(auditCalls),
      "an audit({...}) call now hands the persisted sink an Error. It rebuilds objects from " +
        "Object.entries(), so name/message/stack are DROPPED and the row records {} — reduce it " +
        "to .message or .code at the call site, or re-decide the sink's policy on this evidence: " +
        "docs/decisions/0016-error-serialisation-in-the-persisting-sinks.md",
    ).toEqual([]);
  });

  it("no sandbox emit passes a bare error", () => {
    expect(
      errorValuedSites(sandboxCalls),
      "a sandbox emitter.emit(...) now hands the SOC 2 audit sink an Error; it persists as {}. " +
        "Reduce it at the call site, or re-decide: " +
        "docs/decisions/0016-error-serialisation-in-the-persisting-sinks.md",
    ).toEqual([]);
  });
});
