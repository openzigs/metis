/**
 * #1263 — every log-meta key in `server/src` that matches `/token/i` must be
 * classified: a count (allowlisted in `logger.ts`, logged in the clear) or a
 * credential (deliberately still redacted).
 *
 * This re-derives the set **from the sources on disk** rather than from a
 * hand-copied list, so a new `someNewToken: n` log call fails the build until
 * someone decides which it is. That is the same shape as the #1225 defect
 * being guarded against elsewhere in this suite — a list typed out by hand
 * stops matching production the moment production moves.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tokenCountMetaKeys } from "../src/lib/logger.js";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * Keys that match `/token/i`, are logged, and are **not** counts. Each stays
 * redacted; each needs a reason.
 *
 * - `tokenId` (`server/src/lib/acp/server.ts`) — the identifier of a verified
 *   bearer token. Not the secret itself, but it is a handle to one and a
 *   correlation key for an authenticated session, so it keeps the default.
 */
const CLASSIFIED_CREDENTIAL_KEYS = new Set(["tokenId"]);

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

const LOG_CALL =
  /\b(?:[A-Za-z_$][\w$]*\.)?(?:logger|log)\s*\.\s*(?:info|warn|error|debug|verbose|silly|http)\s*\(/g;

/** Slice out a balanced call expression starting at the `(` of a log call. */
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

function scanTokenLogKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const src = readFileSync(file, "utf8");
    if (!/token/i.test(src)) continue;
    LOG_CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LOG_CALL.exec(src)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      for (const key of metaKeysOf(sliceCall(src, openIdx))) {
        if (!/token/i.test(key)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        const where = `${path.relative(SRC_ROOT, file)}:${line}`;
        found.set(key, [...(found.get(key) ?? []), where]);
      }
    }
  }
  return found;
}

describe("logger — every /token/i log-meta key in server/src is classified (#1263)", () => {
  const discovered = scanTokenLogKeys();
  const allowlist = tokenCountMetaKeys();
  const normalize = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

  it("finds the token-shaped log keys at all", () => {
    // Anti-vacuity: if the scanner silently stops matching, every assertion
    // below passes trivially. The repo had 22 such keys when #1263 landed.
    expect(
      discovered.size,
      "the source scan found almost no /token/i log keys — the scanner is broken, not the repo",
    ).toBeGreaterThanOrEqual(15);
  });

  it("classifies each one as a count or as a credential", () => {
    const unclassified: string[] = [];
    for (const [key, sites] of discovered) {
      const isCount = allowlist.has(normalize(key));
      const isCredential = CLASSIFIED_CREDENTIAL_KEYS.has(key);
      if (isCount === isCredential) unclassified.push(`${key} (${sites.join(", ")})`);
    }
    expect(
      unclassified,
      "classify each key: add a count to TOKEN_COUNT_META_KEYS in logger.ts, " +
        "or a credential to CLASSIFIED_CREDENTIAL_KEYS here with a reason",
    ).toEqual([]);
  });

  it("keeps every key classified as a credential out of the count allowlist", () => {
    for (const key of CLASSIFIED_CREDENTIAL_KEYS) {
      expect(allowlist.has(normalize(key)), `${key} is both a credential and a count`).toBe(false);
    }
  });
});
