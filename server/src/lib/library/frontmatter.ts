/**
 * Frontmatter parser for Skill + Agent definitions (Phase 10).
 *
 * Skills and Agents are YAML-frontmatter Markdown files matching the shape of
 * `.github/skills/<name>/SKILL.md` and `.github/agents/<name>.agent.md`. We
 * accept inputs from three sources (file paste/upload, GitHub repo connector,
 * filesystem auto-discovery) and need to validate them defensively before
 * persisting. The parser MUST:
 *
 *   • use `js-yaml` with `FAILSAFE_SCHEMA` so YAML aliases like `!!js/function`
 *     or `!!python/object` are rejected by construction (no code execution risk),
 *   • validate top-level keys with zod and reject any unknown keys,
 *   • cap body length to keep prompt-injection blast radius bounded,
 *   • compute a stable sha256 of the canonical (frontmatter + body) form so
 *     duplicate imports are no-ops and audit-log payloads are tamper-evident.
 *
 * The parser does NOT enforce the tool allow-list against any registry \u2014 the
 * `tools` field is a hint surfaced in the UI. Actual tool gating runs through
 * the Phase 4 ApprovalGate + Phase 6 MCP per-project allow-list, never here.
 */
import crypto from "node:crypto";
import yaml from "js-yaml";
import { z } from "zod";

// Hard ceilings keep a malicious skill bundle from blowing up the prompt or
// the audit log. 200 KB body / 50 KB frontmatter is well above any legitimate
// reference shape we observed in `.github/skills/*/SKILL.md`.
export const MAX_BODY_BYTES = 200 * 1024;
export const MAX_FRONTMATTER_BYTES = 50 * 1024;
export const MAX_TAGS = 32;
export const MAX_TOOLS = 64;

const SKILL_TOP_LEVEL_KEYS = new Set([
  "name",
  "description",
  "version",
  "tools",
  "resources",
  "tags",
  "trigger",
  "triggers",
  "argument-hint",
  "model",
  "displayName",
]);

const AGENT_TOP_LEVEL_KEYS = new Set([
  "name",
  "description",
  "displayName",
  "model",
  "tools",
  "tags",
  "handoffs",
  "instructions",
  "version",
  "argument-hint",
  "applyTo",
]);

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const stringList = (max: number) => z.array(z.string().min(1).max(120)).max(max).default([]);

export const skillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).default(""),
    version: z.string().max(40).default("0.1.0"),
    tools: stringList(MAX_TOOLS).optional(),
    resources: stringList(64).optional(),
    tags: stringList(MAX_TAGS).optional(),
    trigger: z.string().max(2_000).optional(),
    triggers: z.array(z.string().min(1).max(2_000)).max(16).optional(),
    "argument-hint": z.string().max(500).optional(),
    model: z.string().max(120).optional(),
    displayName: z.string().max(120).optional(),
  })
  .strict();

export const agentFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).default(""),
    displayName: z.string().max(120).optional(),
    model: z.string().max(120).optional(),
    tools: stringList(MAX_TOOLS).optional(),
    tags: stringList(MAX_TAGS).optional(),
    handoffs: stringList(32).optional(),
    instructions: z.string().max(20_000).optional(),
    version: z.string().max(40).default("0.1.0"),
    "argument-hint": z.string().max(500).optional(),
    applyTo: z.string().max(500).optional(),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

export interface ParsedDocument<T> {
  /** Validated and defaulted frontmatter. */
  frontmatter: T;
  /** Markdown body (everything after the closing `---`). */
  body: string;
  /** SHA-256 of `<canonical-yaml>\n---\n<body>` for dedup + integrity. */
  contentSha256: string;
}

export class FrontmatterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = "FrontmatterError";
  }
}

const FRONTMATTER_DELIM = /^---\s*\r?\n/;

interface RawSplit {
  yaml: string;
  body: string;
}

function splitFrontmatter(raw: string): RawSplit {
  if (typeof raw !== "string") {
    throw new FrontmatterError("INVALID_INPUT", "Source must be a string");
  }
  if (raw.length === 0) {
    throw new FrontmatterError("EMPTY", "Source is empty");
  }
  // Strip BOM up-front so the delimiter regex anchors correctly. Some Windows
  // editors and curl-fetched GitHub blobs prepend it.
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!FRONTMATTER_DELIM.test(normalized)) {
    throw new FrontmatterError(
      "MISSING_FRONTMATTER",
      "File must begin with a `---` YAML frontmatter block",
    );
  }
  const afterOpen = normalized.replace(FRONTMATTER_DELIM, "");
  // Match the close delimiter at the start of a line. The body is everything
  // after it (with one optional trailing newline consumed).
  const closeMatch = afterOpen.match(/\r?\n---\s*\r?\n?/);
  if (!closeMatch || closeMatch.index === undefined) {
    throw new FrontmatterError(
      "UNTERMINATED_FRONTMATTER",
      "Frontmatter block is missing its closing `---` delimiter",
    );
  }
  const yamlText = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  if (Buffer.byteLength(yamlText, "utf8") > MAX_FRONTMATTER_BYTES) {
    throw new FrontmatterError(
      "FRONTMATTER_TOO_LARGE",
      `Frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`,
    );
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new FrontmatterError("BODY_TOO_LARGE", `Body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return { yaml: yamlText, body };
}

function parseYamlSafely(yamlText: string): Record<string, unknown> {
  // FAILSAFE_SCHEMA prevents any constructed types beyond strings/lists/maps.
  // No `!!js/function`, no `!!python/object`, no `!!binary` payload coercion.
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText, { schema: yaml.FAILSAFE_SCHEMA });
  } catch (err) {
    throw new FrontmatterError("YAML_PARSE_ERROR", `YAML parse failed: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) {
    throw new FrontmatterError("EMPTY_FRONTMATTER", "Frontmatter block is empty");
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FrontmatterError("INVALID_FRONTMATTER", "Frontmatter must be a YAML mapping");
  }
  // FAILSAFE_SCHEMA returns scalars as strings only; the schema layer below
  // does the boolean/number coercion explicitly via z.coerce when needed.
  // We keep this object as `Record<string, unknown>` for the zod step.
  return parsed as Record<string, unknown>;
}

function rejectExtraKeys(obj: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(obj)) {
    if (!KEY_PATTERN.test(key)) {
      throw new FrontmatterError("INVALID_KEY", `Frontmatter key '${key}' is not permitted`);
    }
    if (!allowed.has(key)) {
      throw new FrontmatterError(
        "UNKNOWN_KEY",
        `Frontmatter key '${key}' is not allowed for this definition type`,
      );
    }
  }
}

function canonicalize(obj: Record<string, unknown>): string {
  // Stable key order so the sha256 is deterministic regardless of how the YAML
  // happened to be formatted.
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function hashContent(canonical: string, body: string): string {
  return crypto.createHash("sha256").update(canonical).update("\n---\n").update(body).digest("hex");
}

export function parseSkillSource(raw: string): ParsedDocument<SkillFrontmatter> {
  const { yaml: yamlText, body } = splitFrontmatter(raw);
  const obj = parseYamlSafely(yamlText);
  rejectExtraKeys(obj, SKILL_TOP_LEVEL_KEYS);
  const result = skillFrontmatterSchema.safeParse(obj);
  if (!result.success) {
    throw new FrontmatterError(
      "VALIDATION_ERROR",
      `Skill frontmatter failed validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      result.error.flatten(),
    );
  }
  const canonical = canonicalize(result.data as Record<string, unknown>);
  return {
    frontmatter: result.data,
    body: body.trimEnd(),
    contentSha256: hashContent(canonical, body),
  };
}

export function parseAgentSource(raw: string): ParsedDocument<AgentFrontmatter> {
  const { yaml: yamlText, body } = splitFrontmatter(raw);
  const obj = parseYamlSafely(yamlText);
  rejectExtraKeys(obj, AGENT_TOP_LEVEL_KEYS);
  const result = agentFrontmatterSchema.safeParse(obj);
  if (!result.success) {
    throw new FrontmatterError(
      "VALIDATION_ERROR",
      `Agent frontmatter failed validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      result.error.flatten(),
    );
  }
  const canonical = canonicalize(result.data as Record<string, unknown>);
  return {
    frontmatter: result.data,
    body: body.trimEnd(),
    contentSha256: hashContent(canonical, body),
  };
}

/**
 * Bump a semver-ish version string. Accepts plain integers, dotted-N strings,
 * or arbitrary text. For arbitrary text we suffix `-N`. The new version must
 * not collide with any of the supplied existing versions.
 */
export function bumpVersion(current: string, existing: ReadonlySet<string>): string {
  const semver = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  let next: string;
  if (semver) {
    const [major, minor, patch] = [Number(semver[1]), Number(semver[2]), Number(semver[3] ?? "0")];
    next = `${major}.${minor}.${patch + 1}`;
  } else if (/^\d+$/.test(current)) {
    next = String(Number(current) + 1);
  } else {
    next = `${current}-1`;
  }
  if (!existing.has(next)) return next;
  // Walk forward until free \u2014 prevents collision when callers pass an
  // already-bumped version string by mistake.
  for (let i = 1; i < 1000; i += 1) {
    const candidate = next.includes("-")
      ? `${current}-${i + 1}`
      : `${next.split(".").slice(0, 2).join(".")}.${Number(next.split(".")[2]) + i}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new FrontmatterError("VERSION_OVERFLOW", "Could not allocate a new version");
}

/**
 * Compute a stable kebab-case key from a name. Used when the importer needs to
 * derive a unique slug from the frontmatter `name` field.
 */
export function slugifyKey(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!base) throw new FrontmatterError("INVALID_NAME", "Name must produce a non-empty slug");
  return base;
}
