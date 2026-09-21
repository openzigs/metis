/**
 * Epic #394 P2 (#407) — Per-repo `.metis/pr-review.yaml` configuration.
 *
 * Industry escape hatch (Cursor `BUGBOT.md`, CodeRabbit `.coderabbit.yaml`,
 * Greptile `.greptile`). Without per-repo overrides teams hit edge cases
 * (e.g. monorepo with a giant lockfile) and disable the bot entirely.
 *
 * The config file lives in the PR HEAD (so per-PR experiments are
 * possible) and overrides DB defaults for: `maxDiffBytes`, `skipGlobs`,
 * `model`, `severityFloor`, `skipDraftPrs`, `skipAuthors[]`.
 *
 * Validation is strict — unknown keys are rejected so a typo doesn't
 * silently disable a guard. Malformed YAML / schema errors return the
 * defaults plus a `warnings[]` array; the agent posts those warnings as
 * a top-level review comment so the repo author sees the parse error
 * without needing to dig through audit logs.
 */
import yaml from "js-yaml";
import { z } from "zod";

export const PR_REVIEW_CONFIG_PATH = ".metis/pr-review.yaml";
/** Hard cap on the config file size we'll fetch + parse — defence in depth. */
export const PR_REVIEW_CONFIG_MAX_BYTES = 32 * 1024;

/**
 * Allowlist of model identifiers that a per-repo `.metis/pr-review.yaml`
 * may select. A fork PR can author this file, so leaving `model` open
 * lets a forked PR force-pick an arbitrarily expensive model and burn
 * the project budget in a single review (the per-call check has no
 * model-cost gate). Any override outside this list is rejected outright
 * — we do NOT silently downgrade, because a silent downgrade hides the
 * fact that the repo's intent was misconfigured.
 *
 * Keep entries in sync with the model catalogue exposed by the AI
 * provider layer. New models ship through here only after a cost review.
 */
export const PR_REVIEW_ALLOWED_MODELS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
  "claude-3-5-haiku",
  "claude-3-5-sonnet",
  "claude-sonnet-4",
  "claude-opus-4",
] as const;
export type PrReviewAllowedModel = (typeof PR_REVIEW_ALLOWED_MODELS)[number];

/**
 * Hard ceiling on `maxDiffBytes` regardless of project default. Even if
 * the project default is set higher (operator misconfiguration), no
 * per-repo file can lift the diff guard above this absolute cap. Sized
 * to comfortably fit the largest review the budget guard would actually
 * fund (~1 MiB of unified diff text).
 */
export const PR_REVIEW_MAX_DIFF_BYTES_HARD_CAP = 1_048_576;

export const SeverityFloor = z.enum(["info", "minor", "warning", "major", "risk"]);
export type SeverityFloor = z.infer<typeof SeverityFloor>;

/** Severity ordering used by the floor filter (higher index = more severe). */
const SEVERITY_ORDER: Record<SeverityFloor, number> = {
  info: 0,
  minor: 1,
  warning: 2,
  major: 3,
  risk: 4,
};

const HostedComment = z
  .object({
    severity: SeverityFloor.optional(),
  })
  .strict();
void HostedComment; // exported via PrReviewConfigSchema below.

export const PrReviewConfigSchema = z
  .object({
    maxDiffBytes: z
      .number()
      .int()
      .positive()
      .max(
        PR_REVIEW_MAX_DIFF_BYTES_HARD_CAP,
        `maxDiffBytes must not exceed ${PR_REVIEW_MAX_DIFF_BYTES_HARD_CAP} bytes`,
      )
      .optional(),
    skipGlobs: z.array(z.string().min(1)).optional(),
    // Reject — do NOT downgrade — model overrides outside the allowlist.
    // A silent downgrade hides operator intent; an explicit reject puts
    // the warning in front of the repo author via the existing
    // `LoadedPrReviewConfig.warnings` surface.
    model: z.enum(PR_REVIEW_ALLOWED_MODELS as unknown as [string, ...string[]]).optional(),
    severityFloor: SeverityFloor.optional(),
    skipDraftPrs: z.boolean().optional(),
    skipAuthors: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type PrReviewConfig = z.infer<typeof PrReviewConfigSchema>;

export interface LoadConfigInput {
  octokit: ConfigOctokit;
  owner: string;
  repo: string;
  /** PR head SHA — we always read at the head so per-PR experiments work. */
  ref: string;
}

export interface LoadedPrReviewConfig {
  /** Validated config — empty object when no file present. */
  config: PrReviewConfig;
  /** Warnings to surface as a top-level PR comment. */
  warnings: string[];
  /** True iff a file exists at the path (regardless of validity). */
  filePresent: boolean;
}

export type ConfigOctokit = {
  repos: {
    getContent: (params: {
      owner: string;
      repo: string;
      path: string;
      ref?: string;
    }) => Promise<{ data: unknown }>;
  };
};

/**
 * Fetch + parse + validate the per-repo config. Never throws — every
 * failure mode returns the defaults plus a warning string.
 */
export async function loadPerRepoConfig(input: LoadConfigInput): Promise<LoadedPrReviewConfig> {
  const empty: LoadedPrReviewConfig = { config: {}, warnings: [], filePresent: false };
  let raw: string;
  try {
    const resp = await input.octokit.repos.getContent({
      owner: input.owner,
      repo: input.repo,
      path: PR_REVIEW_CONFIG_PATH,
      ref: input.ref,
    });
    raw = decodeContent(resp?.data);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404) return empty;
    return {
      ...empty,
      warnings: [`Failed to fetch ${PR_REVIEW_CONFIG_PATH}: ${(err as Error).message}`],
    };
  }

  if (!raw) return { ...empty, filePresent: true };
  if (Buffer.byteLength(raw, "utf8") > PR_REVIEW_CONFIG_MAX_BYTES) {
    return {
      config: {},
      warnings: [
        `${PR_REVIEW_CONFIG_PATH} exceeds ${PR_REVIEW_CONFIG_MAX_BYTES} bytes — ignoring file.`,
      ],
      filePresent: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.FAILSAFE_SCHEMA });
  } catch (err) {
    return {
      config: {},
      warnings: [
        `${PR_REVIEW_CONFIG_PATH} parse error: ${(err as Error).message}. Falling back to defaults.`,
      ],
      filePresent: true,
    };
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      config: {},
      warnings: [`${PR_REVIEW_CONFIG_PATH} must be a YAML object — falling back to defaults.`],
      filePresent: true,
    };
  }

  // YAML FAILSAFE_SCHEMA returns numeric strings as strings — coerce
  // before zod sees them so users can write `maxDiffBytes: 65536`
  // without quoting.
  const coerced = coerceTypes(parsed);
  const validated = PrReviewConfigSchema.safeParse(coerced);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      config: {},
      warnings: [`${PR_REVIEW_CONFIG_PATH} schema error — ignoring overrides. ${issues}`],
      filePresent: true,
    };
  }

  return { config: validated.data, warnings: [], filePresent: true };
}

function decodeContent(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  // GitHub `getContent` returns `{ type: "file", encoding: "base64", content: "...", size: N }`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as Record<string, any>;
  if (Array.isArray(d) || d.type !== "file") return "";
  if (typeof d.content === "string" && d.encoding === "base64") {
    try {
      return Buffer.from(d.content.replace(/\n/g, ""), "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  if (typeof d.content === "string") return d.content;
  return "";
}

function coerceTypes(parsed: unknown): unknown {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const out: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = parsed as Record<string, any>;
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (k === "maxDiffBytes" && typeof v === "string") {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : v;
      continue;
    }
    if (k === "skipDraftPrs" && typeof v === "string") {
      out[k] = v === "true" ? true : v === "false" ? false : v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Effective config = defaults overridden by repo file. Skip-globs are
 * REPLACED, not concatenated, so a repo can carve out a strict allowlist
 * if they want.
 */
export interface EffectiveDefaults {
  maxDiffBytes: number | null;
  skipGlobs: readonly string[] | null;
  model: string | null;
  severityFloor: SeverityFloor | null;
  skipDraftPrs: boolean;
  skipAuthors: string[];
}

/**
 * Clamp + merge defaults with per-repo overrides.
 *
 * Safety rules (Epic #394 P2 review S1/S2):
 *   - `maxDiffBytes` — overrides may only ever LOWER the cap, never
 *     raise it. The override is clamped to `min(override, default,
 *     PR_REVIEW_MAX_DIFF_BYTES_HARD_CAP)`. When no project default is
 *     configured we still enforce the absolute hard cap.
 *   - `model` — already enforced at parse-time to be on the allowlist,
 *     so by the time we reach this function the value is safe to apply
 *     verbatim. We document the constraint here for callers.
 */
export function mergePerRepoConfig(
  defaults: EffectiveDefaults,
  override: PrReviewConfig,
): EffectiveDefaults {
  return {
    maxDiffBytes: clampMaxDiffBytes(defaults.maxDiffBytes, override.maxDiffBytes),
    skipGlobs: override.skipGlobs ?? defaults.skipGlobs,
    model: override.model ?? defaults.model,
    severityFloor: override.severityFloor ?? defaults.severityFloor,
    skipDraftPrs: override.skipDraftPrs ?? defaults.skipDraftPrs,
    skipAuthors: override.skipAuthors ?? defaults.skipAuthors,
  };
}

function clampMaxDiffBytes(
  defaultBytes: number | null,
  overrideBytes: number | undefined,
): number | null {
  // No override → defaults pass through, but still cap at the hard
  // ceiling so a misconfigured project default cannot OOM the agent.
  if (overrideBytes == null) {
    if (defaultBytes == null) return null;
    return Math.min(defaultBytes, PR_REVIEW_MAX_DIFF_BYTES_HARD_CAP);
  }
  const ceiling =
    defaultBytes != null
      ? Math.min(defaultBytes, PR_REVIEW_MAX_DIFF_BYTES_HARD_CAP)
      : PR_REVIEW_MAX_DIFF_BYTES_HARD_CAP;
  return Math.min(overrideBytes, ceiling);
}

/** True when `actual` is at or below the configured floor (i.e. should be dropped). */
export function isBelowSeverityFloor(
  actual: "info" | "warning" | "risk",
  floor: SeverityFloor | null | undefined,
): boolean {
  if (!floor) return false;
  // Map judge severities (info|warning|risk) to the floor scale.
  // We treat judge "warning" === floor "warning"; judge "risk" === floor "risk".
  const judgeRank: Record<"info" | "warning" | "risk", number> = {
    info: SEVERITY_ORDER.info,
    warning: SEVERITY_ORDER.warning,
    risk: SEVERITY_ORDER.risk,
  };
  return judgeRank[actual] < SEVERITY_ORDER[floor];
}

/** True when the PR author matches the per-repo skip list (case-insensitive). */
export function shouldSkipAuthor(
  author: string | null | undefined,
  list: readonly string[],
): boolean {
  if (!author) return false;
  const normalized = author.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === normalized);
}
