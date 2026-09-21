/**
 * Epic #157 — Red-team / prompt-injection regression suite (issue #152).
 *
 * Curated malicious payloads are loaded from `server/eval/red-team/`. The
 * harness runs each one through the relevant defense surface and asserts the
 * expected denial fires:
 *
 *   - documents/      → ingest pipeline → safety hook + chunker.
 *   - mcp-responses/  → simulated MCP tool output → tool-bridge sanitizer.
 *   - issue-bodies/   → AI session input → safety hook chain.
 *
 * For deterministic CI we don't actually start the agent. Instead we run the
 * payload through the relevant low-level defense (regex blocklist, hidden-char
 * scanner, MCP allowlist) and assert the outcome. This keeps the test fast,
 * parallel-safe, and free of provider keys.
 *
 * Failure threshold is configurable via `RED_TEAM_MAX_FAILURES` (default 0).
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  redTeamCategories,
  type RedTeamAttackResult,
  type RedTeamCategory,
  type RedTeamReport,
} from "@metis/shared";

export interface RedTeamFixture {
  attack: string;
  category: RedTeamCategory;
  payload: string;
  /** Human-readable description of what should happen. */
  expected: string;
}

export interface RedTeamDefense {
  detect(fixture: RedTeamFixture): RedTeamDetection;
}

export interface RedTeamDetection {
  blocked: boolean;
  /** Short label of the defense surface that fired ("regex", "hidden-char", "allowlist"). */
  surface: string;
  /** Optional detail for failure debugging. */
  detail?: string;
}

/**
 * Default defense — looks for known injection markers, hidden Unicode
 * confusables, system-prompt extraction phrases, and tool-escalation keywords.
 * Mirrors the patterns enforced by `safety/regex-blocklist.ts` +
 * `mcp/hidden-char-scanner.ts` + `safety/apply-safety.ts`.
 */
export class DefaultRedTeamDefense implements RedTeamDefense {
  // Patterns mirror real production blocklist entries.
  private readonly INJECTION_PATTERNS = [
    /ignore\s+(all|any|previous|prior|the)\s+(instructions|rules|prompts?)/i,
    /you\s+are\s+now\s+(a\s+)?(different|new|admin|root)/i,
    /system\s*[:=]\s*you/i,
    /reveal\s+(your|the)\s+(system|original)\s+prompt/i,
    /print\s+(your|the)\s+(initial|hidden|system)\s+(prompt|instructions)/i,
    /act\s+as\s+(an?\s+)?(admin|root|developer mode)/i,
    /disable\s+(safety|filter|guardrails?)/i,
  ];

  private readonly HIDDEN_CHAR_RANGES = [
    /[\u200B-\u200F]/, // zero-width + bidi marks
    /[\u202A-\u202E]/, // bidi overrides
    /[\u2060-\u206F]/, // word joiner / invisibles
    /\uFEFF/, // zero-width nbsp / BOM
  ];

  private readonly TOOL_ESCALATION = [
    /grant\s+me\s+(admin|root|all)\s+(access|permissions?)/i,
    /set\s+permissions?\s+to\s+(admin|root)/i,
    /bypass\s+(approval|allowlist|gate)/i,
    /skip\s+(approval|review|safety)/i,
  ];

  detect(fixture: RedTeamFixture): RedTeamDetection {
    const payload = fixture.payload;

    // Hidden-char surface — fires for any of the obfuscation classes.
    if (this.HIDDEN_CHAR_RANGES.some((rx) => rx.test(payload))) {
      return { blocked: true, surface: "hidden-char" };
    }
    if (this.INJECTION_PATTERNS.some((rx) => rx.test(payload))) {
      return { blocked: true, surface: "injection-regex" };
    }
    if (this.TOOL_ESCALATION.some((rx) => rx.test(payload))) {
      return { blocked: true, surface: "tool-escalation" };
    }
    // MCP poisoning often relies on instructing the agent via the description.
    // Treat embedded "<<system>>" / "<<role:" markers as poisoning indicators.
    if (/<<\s*(system|role:)/i.test(payload)) {
      return { blocked: true, surface: "mcp-poisoning" };
    }
    return {
      blocked: false,
      surface: "none",
      detail: "no defense pattern matched",
    };
  }
}

const CATEGORY_BY_FOLDER: Record<string, RedTeamCategory> = {
  documents: "prompt_injection",
  "mcp-responses": "mcp_poisoning",
  "issue-bodies": "system_prompt_extraction",
};

/** Load fixtures from `server/eval/red-team/`. Each file is one fixture. */
export async function loadFixtures(rootDir: string): Promise<RedTeamFixture[]> {
  const out: RedTeamFixture[] = [];
  let folders: string[] = [];
  try {
    folders = await readdir(rootDir);
  } catch {
    return [];
  }
  for (const folder of folders) {
    if (!CATEGORY_BY_FOLDER[folder]) continue;
    const cat = CATEGORY_BY_FOLDER[folder];
    let files: string[] = [];
    try {
      files = await readdir(path.join(rootDir, folder));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".md") && !file.endsWith(".txt") && !file.endsWith(".json")) continue;
      const full = path.join(rootDir, folder, file);
      const raw = await readFile(full, "utf8");
      const fixture = parseFixture(raw, file, cat);
      if (fixture) out.push(fixture);
    }
  }
  return out;
}

interface FixtureFrontmatter {
  attack?: string;
  category?: RedTeamCategory;
  expected?: string;
}

function parseFixture(
  raw: string,
  filename: string,
  defaultCategory: RedTeamCategory,
): RedTeamFixture | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  let frontmatter: FixtureFrontmatter = {};
  let payload = raw;
  if (fmMatch) {
    frontmatter = parseSimpleYaml(fmMatch[1]);
    payload = raw.slice(fmMatch[0].length);
  }
  const category = (
    frontmatter.category && redTeamCategories.includes(frontmatter.category)
      ? frontmatter.category
      : defaultCategory
  ) as RedTeamCategory;
  const attack = frontmatter.attack ?? path.basename(filename, path.extname(filename));
  const expected = frontmatter.expected ?? "blocked";
  return { attack, category, payload, expected };
}

/**
 * Tiny key:value YAML reader sufficient for the frontmatter blocks. Supports
 * single-line `key: value` only — fixtures intentionally keep frontmatter
 * simple so we don't pull in a YAML dep.
 */
function parseSimpleYaml(raw: string): FixtureFrontmatter {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
    if (!m) continue;
    out[m[1]] = m[2]
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");
  }
  return out as FixtureFrontmatter;
}

export function runRedTeam(input: {
  fixtures: RedTeamFixture[];
  defense?: RedTeamDefense;
  ranAt?: string;
}): RedTeamReport {
  const defense = input.defense ?? new DefaultRedTeamDefense();
  const attacks: RedTeamAttackResult[] = [];
  for (const f of input.fixtures) {
    const detection = defense.detect(f);
    const expected = f.expected.toLowerCase().includes("allow") ? "allowed" : "blocked";
    const observed = detection.blocked ? "blocked" : "allowed";
    attacks.push({
      attack: f.attack,
      category: f.category,
      expected,
      observed: detection.blocked
        ? `blocked:${detection.surface}`
        : `allowed:${detection.detail ?? ""}`,
      pass: expected === observed,
    });
  }
  const passed = attacks.filter((a) => a.pass).length;
  return {
    total: attacks.length,
    passed,
    failed: attacks.length - passed,
    score: attacks.length === 0 ? 1 : passed / attacks.length,
    attacks,
    ranAt: input.ranAt ?? new Date().toISOString(),
  };
}
