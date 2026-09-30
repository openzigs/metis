/** Idempotent generated-document outboxes replayed after interruption, never cancellation. */
export const DURABLE_TASK_TYPES = [
  "regenerate-generated-document",
  "schedule-regeneration", // #449 — retries scheduling without re-ingesting.
  "publish-generated-document", // Includes deletion cleanup of the synthetic document.
] as const;

export function isDurableTask(type: string): boolean {
  return DURABLE_TASK_TYPES.some((durable) => durable === type);
}
