/**
 * #2333 — `safety/secret-patterns.ts` is the ONE secret set. The connector
 * redactor (`connectors/pii-redactor.ts`) and the definition scan
 * (`agent-runtime/secret-scan.ts`) each kept a private, diverging copy until
 * #2333; a copy drifts (one list knew Slack tokens, the other did not). Fails
 * when a copy comes back:
 *
 *   1. no file under `server/src` other than the module repeats one of its
 *      patterns (by regex source);
 *   2. neither consumer declares a regex literal naming a secret shape.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankComments } from "./helpers/source-scan.js";
import { SECRET_PATTERNS } from "../src/lib/safety/secret-patterns.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const MODULE = "lib/safety/secret-patterns.ts";
const CONSUMERS = ["lib/connectors/pii-redactor.ts", "lib/agent-runtime/secret-scan.ts"];

/** A secret shape's distinctive token, as it would appear inside a regex literal. */
const SHAPE_TOKENS = [
  "AKIA",
  "ghp",
  "gh[pousr]",
  "github_pat",
  "sk-ant",
  "xox",
  "PRIVATE KEY",
  "AIza",
  "Bearer",
  "eyJ",
  "[a-f0-9]{32",
  "glpat",
  "hooks\\.slack",
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const rel = (abs: string): string => path.relative(SRC, abs).split(path.sep).join("/");

/** Every `/…/flags` regex literal in a comment-blanked source, roughly. */
function regexLiterals(src: string): string[] {
  return [
    ...src.matchAll(
      /(?<=[=(,:[!&|?{};]\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+\/[a-z]*/g,
    ),
  ].map((m) => m[0]);
}

describe("#2333 — one secret set", () => {
  it("no other server source file repeats one of the module's patterns", () => {
    const copies: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (rel(file) === MODULE) continue;
      const src = blankComments(readFileSync(file, "utf8"));
      for (const p of SECRET_PATTERNS) {
        if (src.includes(p.re.source)) copies.push(`${rel(file)} repeats ${p.id}`);
      }
    }
    expect(copies).toEqual([]);
  });

  it.each(CONSUMERS)("%s declares no secret-shaped regex of its own", (file) => {
    const src = blankComments(readFileSync(path.join(SRC, file), "utf8"));
    expect(src).toContain('from "../safety/secret-patterns.js"');
    const own = regexLiterals(src).filter((lit) => SHAPE_TOKENS.some((t) => lit.includes(t)));
    expect(own).toEqual([]);
  });

  it("the scan can see a copy: it flags the pre-#2333 consumer shapes", () => {
    const before = [
      "const GH_PAT = /\\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g;",
      '  { kind: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },',
    ].join("\n");
    const own = regexLiterals(before).filter((lit) => SHAPE_TOKENS.some((t) => lit.includes(t)));
    expect(own).toHaveLength(2);
  });
});
