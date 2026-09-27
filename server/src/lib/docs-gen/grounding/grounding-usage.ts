/**
 * #180 — token usage of the grounding calls (claim extraction and the
 * faithfulness judge). The grounders know nothing about projects or runs, so
 * they report each completed call's usage to a listener their builder supplies;
 * the synthesizer records it exactly like a section call (usage dashboard and
 * the run's cost estimate).
 */
import type { ChatResponse } from "../../ai/types.js";

/** One completed grounding call's usage. */
export interface GroundingUsageEvent {
  stage: "claims" | "verdicts";
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Receives one event per grounding call that returned a response. */
export type GroundingUsageListener = (event: GroundingUsageEvent) => void;

/**
 * Report `response`'s usage to `listener`, once. A response with no tokens at
 * all (an offline stub, an adapter that reports none) is not reported. The
 * model is the one that answered, else the one asked for, else the provider's.
 */
export function reportGroundingUsage(
  listener: GroundingUsageListener | undefined,
  stage: GroundingUsageEvent["stage"],
  response: Pick<ChatResponse, "usage" | "model" | "provider"> | undefined,
  fallback: { provider: string; model: string },
): void {
  if (!listener || !response?.usage) return;
  const u = response.usage;
  const event: GroundingUsageEvent = {
    stage,
    provider: response.provider || fallback.provider,
    model: response.model || fallback.model,
    inputTokens: u.promptTokens ?? 0,
    outputTokens: u.completionTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0,
  };
  if (
    event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens ===
    0
  ) {
    return;
  }
  listener(event);
}
