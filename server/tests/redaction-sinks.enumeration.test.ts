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
import { tokenCountMetaKeys } from "../src/lib/logger.js";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** The three registered sinks and the policy each declares in-file. */
const REGISTERED_SINKS: ReadonlyMap<string, string> = new Map([
  ["lib/logger.ts", "exempt-token-counts"],
  ["lib/audit/audit-service.ts", "exempt-token-counts"],
  ["lib/sandbox/audit/redact.ts", "no-token-count-exemption"],
]);

const RECOGNISED_POLICIES = new Set(["exempt-token-counts", "no-token-count-exemption"]);

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
 * Blank every comment, replacing its characters with spaces so byte offsets and
 * line numbers are preserved exactly.
 *
 * This is load-bearing twice over. A *discussion* of `/token/i` — which several
 * modules carry, correctly — must not be mistaken for a declaration of one. And
 * an apostrophe in prose (`the UI's`) opens a phantom string for the balanced
 * slicer below, which then runs to end-of-file and attributes every key in the
 * rest of the module to one call. That is not hypothetical: it is what the
 * first draft of this scan did to `analysis/orchestrator.ts:1703`.
 */
function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  let prevSignificant = "";
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < out.length; j++) if (out[j] !== "\n") out[j] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? src.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        j++;
      }
      i = j + 1;
      prevSignificant = c;
      continue;
    }
    // A `/` here is a regex literal when the previous significant character
    // cannot end an expression — otherwise it is division.
    if (c === "/" && (prevSignificant === "" || "=(,:[!&|?{};+-*%~^<>".includes(prevSignificant))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        else if (src[j] === "\n") break;
        j++;
      }
      i = j + 1;
      prevSignificant = "/";
      continue;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join("");
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
