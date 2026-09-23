/**
 * #67 — no call site in `server/src` may hand an EXCEPTION's own text to
 * `sectionFailedWarning`.
 *
 * That warning's message is persisted in `GeneratedDocument.warnings`, returned
 * by `GET /projects/:projectId/docs/:docId` and rendered in the UI banner, so a
 * raw exception there puts provider response bodies, server paths and SQL text
 * in front of a user — the exposure #52 closed for a *failed* row's
 * `errorMessage`, reopened on the *degraded* path. The one offender
 * (`holistic-synthesizer.ts`, `String(err)`) now maps through
 * `generationFailureMessage` first.
 *
 * `publicDocWarnings` sanitises on READ, but only for warnings lacking
 * `detailSafe` — which every builder sets. So a NEW call site passing
 * `String(err)` would be marked safe and sail straight through. This test is
 * what stops that: it re-derives the call sites from the sources on disk rather
 * than from a hand-copied list, so a new offender fails the build.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankComments } from "./helpers/source-scan.js";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

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

/**
 * Expressions that carry an exception's own text. `generationFailureMessage(err)`
 * is deliberately NOT one of them: it consumes the error and returns a fixed
 * string, which is exactly the required shape.
 */
const RAW_ERROR_EXPR = [
  /\bString\s*\(\s*(?:err|error|e|cause|ex)\b/,
  /\b(?:err|error|e|cause|ex)\s*(?:\?\.)?\s*\.\s*(?:message|stack|toString)\b/,
  /\b(?:err|error|ex)\s+instanceof\s+Error\s*\?/,
  /\$\{\s*(?:err|error|e|cause|ex)\s*\}/,
];

interface CallSite {
  where: string;
  detail: string;
}

/**
 * Call sites in ONE source text. Exposed separately from the file walk so the
 * gate itself can be exercised against a fixture — see the prose arm below.
 *
 * #85/#86 — comments are blanked before scanning. This read RAW source, so a doc
 * comment that merely NAMED the pre-#67 `sectionFailedWarning(label,
 * String(err))` shape was reported as a call site passing an exception, and
 * #86's fix — whose whole subject is that builder — tripped the gate it was
 * honouring. A gate that cannot tell prose from code gets the prose reworded
 * instead of the code fixed; `redaction-sinks.enumeration.test.ts` already
 * carried that lesson, and this scanner was the second copy without it.
 */
function callSitesIn(rawSrc: string, where: string): CallSite[] {
  const sites: CallSite[] = [];
  const src = blankComments(rawSrc);
  // The declaration itself is not a call site.
  // #157 — `batchFailedWarning` carries the same persisted, detail-safe
  // message for a failed batch of a batched section, so it is held to the
  // same contract.
  const CALL = /\b(?:sectionFailedWarning|batchFailedWarning)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = CALL.exec(src)) !== null) {
    if (
      /export function\s+(?:sectionFailedWarning|batchFailedWarning)\s*\($/.test(
        src.slice(0, m.index + m[0].length),
      )
    )
      continue;
    const openIdx = m.index + m[0].length - 1;
    const call = sliceCall(src, openIdx);
    const line = src.slice(0, m.index).split("\n").length;
    sites.push({ where: `${where}:${line}`, detail: call });
  }
  return sites;
}

function sectionFailedWarningCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of collectSourceFiles(SRC_ROOT)) {
    sites.push(...callSitesIn(readFileSync(file, "utf8"), path.relative(SRC_ROOT, file)));
  }
  return sites;
}

describe("sectionFailedWarning — the detail contract is checked, not just documented (#67)", () => {
  const sites = sectionFailedWarningCallSites();

  it("finds the call sites at all, so a passing run means something", () => {
    // If this ever reads zero the scan has silently stopped matching and every
    // assertion below would pass over an unchecked codebase.
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((s) => s.where.startsWith("lib/docs-gen/"))).toBe(true);
    // The batched-section call site is scanned too, not just the older one.
    expect(sites.some((s) => s.detail.includes("generationFailureMessage(f.err)"))).toBe(true);
  });

  it("no call site passes an exception's own message, stack or String(err)", () => {
    const offenders = sites.filter((s) => RAW_ERROR_EXPR.some((rx) => rx.test(s.detail)));
    expect(
      offenders.map((o) => o.where),
      "map the error through generationFailureMessage() before building the warning",
    ).toEqual([]);
  });

  it("does not mistake prose about the offending shape for a call site", () => {
    // The regression this arm exists for, asserted through the GATE rather than
    // through `blankComments` alone: a fixture whose offending text lives only
    // in comments must yield no offender, while the one real call in the same
    // fixture is still found — so dropping the blanking fails, and blanking too
    // greedily fails too.
    const fixture = [
      "/**",
      " * Built by the OLD sectionFailedWarning(label, String(err)), so the",
      " * exception string is embedded in the persisted blob.",
      " */",
      "// see also sectionFailedWarning(section, err.message)",
      "const safe = sectionFailedWarning(section, generationFailureMessage(raw));",
    ].join("\n");
    const found = callSitesIn(fixture, "fixture.ts");
    expect(found.map((f) => f.detail)).toEqual(["(section, generationFailureMessage(raw))"]);
    expect(found.filter((f) => RAW_ERROR_EXPR.some((rx) => rx.test(f.detail)))).toEqual([]);
  });

  it("recognises the offending shape when it is present", () => {
    // The guard's own mutation arm: the matcher must actually match. Without
    // this, deleting a pattern from RAW_ERROR_EXPR would leave the test green.
    const bad = [
      "sectionFailedWarning(group.label, String(err))",
      "sectionFailedWarning(group.label, err.message)",
      "batchFailedWarning(group.label, names, String(err))",
      "sectionFailedWarning(label, `${err}`)",
      'sectionFailedWarning(label, error instanceof Error ? error.message : "x")',
    ];
    for (const sample of bad) {
      expect(
        RAW_ERROR_EXPR.some((rx) => rx.test(sample)),
        sample,
      ).toBe(true);
    }
    const good = [
      "sectionFailedWarning(group.label, generationFailureMessage(err))",
      'sectionFailedWarning(section, "model returned no content (empty section output)")',
    ];
    for (const sample of good) {
      expect(
        RAW_ERROR_EXPR.some((rx) => rx.test(sample)),
        sample,
      ).toBe(false);
    }
  });
});
