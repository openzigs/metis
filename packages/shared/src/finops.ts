/**
 * Epic #164 — FinOps + safety contracts shared between server and UI.
 *
 * Three concerns live here:
 *   1. Per-project safety mode + the SafetyEvent shape persisted by the
 *      server's SafetyHook chain.
 *   2. Per-call TokenUsage telemetry rolled up into project-level usage
 *      summaries (`UsageSummary`).
 *   3. Project setting payloads for the new `PATCH /api/projects/:id/safety`,
 *      `/budget`, and `/autopilot` routes.
 */
import { z } from "zod";

// ---- Safety -----------------------------------------------------------------
export const SAFETY_MODES = ["strict", "standard", "off"] as const;
export type SafetyMode = (typeof SAFETY_MODES)[number];

export const SAFETY_DIRECTIONS = ["input", "output"] as const;
export type SafetyDirection = (typeof SAFETY_DIRECTIONS)[number];

export const SAFETY_VERDICTS = ["allowed", "blocked", "redacted"] as const;
export type SafetyVerdict = (typeof SAFETY_VERDICTS)[number];

/** Single safety finding emitted by a SafetyHook implementation. */
export const safetyFindingSchema = z.object({
  /** PII kind ("ssn", "credit_card", "phone", "email") or pattern label. */
  kind: z.string().min(1).max(64),
  /** Optional human-readable explanation. */
  message: z.string().max(512).optional(),
  /** Number of matches in the source text. */
  count: z.number().int().min(0).default(0),
});
export type SafetyFinding = z.infer<typeof safetyFindingSchema>;

export const safetyEventDtoSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sessionId: z.string().nullable(),
  direction: z.enum(SAFETY_DIRECTIONS),
  verdict: z.enum(SAFETY_VERDICTS),
  findings: z.array(safetyFindingSchema),
  createdAt: z.string(),
});
export type SafetyEventDto = z.infer<typeof safetyEventDtoSchema>;

// ---- Usage / FinOps ---------------------------------------------------------
export const usageByProviderSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  /** Cost of this model's PRICED usage; `null` when none of it was priced (#22). */
  costCents: z.number().int().min(0).nullable(),
  /** #22 — tokens recorded while this model had no price. */
  unpricedTokens: z.number().int().min(0),
});
export type UsageByProvider = z.infer<typeof usageByProviderSchema>;

export const usageByDaySchema = z.object({
  /** UTC YYYY-MM-DD bucket. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  costCents: z.number().int().min(0),
  /** #22 — tokens that day from models with no price. */
  unpricedTokens: z.number().int().min(0),
});
export type UsageByDay = z.infer<typeof usageByDaySchema>;

export const unpricedUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  calls: z.number().int().min(0),
});
export type UnpricedUsage = z.infer<typeof unpricedUsageSchema>;

export const usageSummarySchema = z.object({
  projectId: z.string().min(1),
  /** Window start (inclusive) — ISO timestamp. */
  from: z.string(),
  /** Window end (exclusive) — ISO timestamp. */
  to: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  /** Cost of the PRICED usage in the window (excludes {@link unpriced}). */
  costCents: z.number().int().min(0),
  /**
   * #22 — usage from models METIS had no price for. Shown separately so an
   * unknown cost never reads as $0.
   */
  unpriced: unpricedUsageSchema,
  /** Calendar-month projected cost (MTD × daysInMonth/dayOfMonth). */
  projectedMonthlyCostCents: z.number().int().min(0),
  /** `monthlyTokenBudget` resolved at query time (null = no cap). */
  monthlyTokenBudget: z.number().int().min(0).nullable(),
  /** Tokens used MTD — distinct from `totalTokens` when window != month. */
  monthToDateTokens: z.number().int().min(0),
  /** MTD tokens left out of `projectedMonthlyCostCents` because unpriced. */
  monthToDateUnpricedTokens: z.number().int().min(0),
  byProvider: z.array(usageByProviderSchema),
  byDay: z.array(usageByDaySchema),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

// ---- Project settings payloads ---------------------------------------------
export const updateSafetyModeSchema = z.object({
  safetyMode: z.enum(SAFETY_MODES),
});
export type UpdateSafetyModeInput = z.infer<typeof updateSafetyModeSchema>;

export const updateBudgetSchema = z.object({
  /** Null clears the cap; positive integers set a token-count budget. */
  monthlyTokenBudget: z.number().int().min(1).max(2_000_000_000).nullable(),
});
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;

export const updateAutopilotSchema = z.object({
  enabled: z.boolean(),
  /** Null clears the ceiling. Cents — positive integers only. */
  costCeilingCents: z.number().int().min(1).max(1_000_000_00).nullable().optional(),
});
export type UpdateAutopilotInput = z.infer<typeof updateAutopilotSchema>;

// ---- Socket event ----------------------------------------------------------
export const usageTickEventSchema = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  /** `null` = the model is unpriced (#22). */
  costCents: z.number().int().min(0).nullable(),
  ts: z.number().int().min(0),
});
export type UsageTickEvent = z.infer<typeof usageTickEventSchema>;
