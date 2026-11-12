/**
 * #2333 — `safety/secret-patterns.ts` is the ONE secret set. The connector
 * redactor (`connectors/pii-redactor.ts`) and the definition scan
 * (`agent-runtime/secret-scan.ts`) each kept a private, diverging copy until
 * #2333; a copy drifts (one list knew Slack tokens, the other did not). Fails
 * when a copy comes back:
 *
 *   1. no file under `server/src` other than the module repeats one of its
 *      patterns (by regex source);
 *   2. no consumer declares a regex literal naming a secret shape, but for the
 *      sink-specific ones it lists with the reason (the sandbox audit sink);
 *   3. the MCP importer's whole-value classifier is the one documented
 *      exception, and says why in its source.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankComments } from "./helpers/source-scan.js";
import { SECRET_PATTERNS } from "../src/lib/safety/secret-patterns.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const MODULE = "lib/safety/secret-patterns.ts";
/**
 * Each consumer, and the shape tokens its OWN regexes may still name. The
 * sandbox audit sink keeps two looser shapes on purpose (`sandbox/audit/redact.ts`
 * says why): `Bearer` in its header-preserving `auth-header`, `AIza` in a
 * prefix-only Google key shape. Every other token there would be a copy.
 */
const CONSUMERS: ReadonlyArray<[string, readonly string[]]> = [
  ["lib/connectors/pii-redactor.ts", []],
  ["lib/agent-runtime/secret-scan.ts", []],
  ["lib/sandbox/audit/redact.ts", ["Bearer", "AIza"]],
];
/** Kept apart from the shared set on purpose: a whole-value vaulting classifier. */
const DOCUMENTED_EXCEPTION = "lib/mcp/mcp-importer.ts";

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

  it.each(CONSUMERS)("%s declares no secret-shaped regex of its own", (file, allowed) => {
    const src = blankComments(readFileSync(path.join(SRC, file), "utf8"));
    expect(src).toMatch(/from "(?:\.\.\/)+safety\/secret-patterns\.js"/);
    const tokens = SHAPE_TOKENS.filter((t) => !allowed.includes(t));
    const own = regexLiterals(src).filter((lit) => tokens.some((t) => lit.includes(t)));
    expect(own).toEqual([]);
  });

  it("the sandbox audit sink's vendor shapes are gone: only its listed own shapes remain", () => {
    const src = blankComments(readFileSync(path.join(SRC, "lib/sandbox/audit/redact.ts"), "utf8"));
    const named = regexLiterals(src).flatMap((lit) => SHAPE_TOKENS.filter((t) => lit.includes(t)));
    expect([...new Set(named)].sort()).toEqual(["AIza", "Bearer"]);
  });

  it("the MCP importer is the one documented exception, and its source says why", () => {
    const raw = readFileSync(path.join(SRC, DOCUMENTED_EXCEPTION), "utf8");
    expect(raw).toContain("#2333 — deliberately NOT the shared set");
    // Still a whole-value classifier: every one of its value shapes is anchored.
    const src = blankComments(raw);
    const shaped = regexLiterals(src).filter((lit) => SHAPE_TOKENS.some((t) => lit.includes(t)));
    expect(shaped.length).toBeGreaterThan(0);
    for (const lit of shaped) expect(lit, lit).toMatch(/^\/\^.*\$\/[a-z]*$/);
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
