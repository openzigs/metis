/**
 * #1327 — how much longer than asked a model writes a planned batch, so the
 * words a batch prompt requests can be corrected for it.
 *
 * Measured on the stored sections of the walkthrough Miniflux BRD (#995), in
 * rendered characters against the planned share: DeepSeek `deepseek-flash`
 * 1.30–1.45× AFTER the section cap had already trimmed its catalogue sections,
 * and 1.50–1.64× before it (run B, 2026-10-21: each catalogue section's reply
 * length in the "Batched section synthesized" log, converted at that section's
 * own drafted-to-rendered ratio); Haiku 1.00–1.16×. A model writes its reply
 * long whatever the prompt says, so a batch asked for its plan in words comes
 * back half as long again, and the hold ({@link holdBatchReply}) then has to
 * drop topics it wrote. Asking for `planned / overrun` words lands the reply
 * near its plan instead.
 *
 * The factor only divides the words a prompt REQUESTS; the planned shares a
 * reply is held to are unchanged. A model with no entry is asked for its plan
 * as before (factor 1), so a well-calibrated model is never asked for less.
 *
 * Pure apart from reading the setting, and logging once each value of it that
 * has an entry it ignores or clamps.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("docs-gen:length-calibration");

/** Registry key: per-model overrides, `pattern=factor` pairs separated by commas. */
export const LENGTH_OVERRUN_KEY = "DOCS_GEN_LENGTH_OVERRUN";

/** The smallest and largest factor honoured; a value outside is clamped. */
export const MIN_LENGTH_OVERRUN = 0.5;
export const MAX_LENGTH_OVERRUN = 3;

export interface LengthOverrunRule {
  /** Matched case-insensitively as a substring of the model id; `*` matches every model. */
  pattern: string;
  factor: number;
}

/**
 * The built-in factors, checked after the configured ones. DeepSeek's is the
 * low end of its pre-cap measurement (1.50–1.64): a factor too low costs the
 * lowest-priority topics of a batch to the hold; one too high leaves room
 * unused, which nothing can give back after the batch is written.
 *
 * Measured on ONE model id, `deepseek-flash` (walkthrough run B, 2026-10-21),
 * and extrapolated to every id containing `deepseek` (`deepseek-chat`,
 * `deepseek-reasoner`, …) on the assumption that they write alike. That is
 * unmeasured; set `DOCS_GEN_LENGTH_OVERRUN` for an id that is measured to
 * differ.
 */
export const DEFAULT_LENGTH_OVERRUN_RULES: readonly LengthOverrunRule[] = [
  { pattern: "deepseek", factor: 1.5 },
];

const clamp = (factor: number): number =>
  Math.min(MAX_LENGTH_OVERRUN, Math.max(MIN_LENGTH_OVERRUN, factor));

/**
 * Parse `DOCS_GEN_LENGTH_OVERRUN` (`deepseek=1.4, haiku=1.1, *=1`). Entries
 * that do not read as `pattern=number` with a number above 0 are returned in
 * `unrecognised` and otherwise ignored, so one typo does not discard the
 * rest; entries outside the honoured range are clamped and returned in
 * `clamped`.
 */
export function parseLengthOverrun(raw: string | undefined | null): {
  rules: LengthOverrunRule[];
  unrecognised: string[];
  clamped: string[];
} {
  const rules: LengthOverrunRule[] = [];
  const unrecognised: string[] = [];
  const clamped: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const text = entry.trim();
    if (text === "") continue;
    const at = text.lastIndexOf("=");
    const pattern = at > 0 ? text.slice(0, at).trim().toLowerCase() : "";
    const value = at > 0 ? text.slice(at + 1).trim() : "";
    const factor = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
    if (pattern === "" || !Number.isFinite(factor) || factor <= 0) {
      unrecognised.push(text);
      continue;
    }
    if (clamp(factor) !== factor) clamped.push(text);
    rules.push({ pattern, factor: clamp(factor) });
  }
  return { rules, unrecognised, clamped };
}

/** The setting values already reported, so each is logged once per process. */
const reported = new Set<string>();
const REPORTED_MAX = 32;

/**
 * The overrun factor of `model`: the first configured rule that matches, else
 * the first built-in one, else 1. A configured `*` applies to every model the
 * configured rules before it did not match, ahead of the built-in rules.
 */
export function resolveLengthOverrun(
  model: string | undefined | null,
  config: ConfigService = getConfigService(),
): number {
  const id = (model ?? "").toLowerCase();
  const raw = config.get(LENGTH_OVERRUN_KEY);
  const { rules, unrecognised, clamped } = parseLengthOverrun(raw);
  if (
    raw &&
    (unrecognised.length > 0 || clamped.length > 0) &&
    !reported.has(raw) &&
    reported.size < REPORTED_MAX
  ) {
    reported.add(raw);
    log.warn("DOCS_GEN_LENGTH_OVERRUN has entries it ignores or clamps", {
      ignored: unrecognised.map((entry) => entry.slice(0, 60)),
      clamped: clamped.map((entry) => entry.slice(0, 60)),
      range: [MIN_LENGTH_OVERRUN, MAX_LENGTH_OVERRUN],
    });
  }
  for (const rule of [...rules, ...DEFAULT_LENGTH_OVERRUN_RULES]) {
    if (rule.pattern === "*" || (id !== "" && id.includes(rule.pattern))) return rule.factor;
  }
  return 1;
}
