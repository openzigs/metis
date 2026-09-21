/**
 * Epic #394 P2 (#403) — Webhook delivery dedup helper.
 *
 * GitHub re-delivers webhooks on transient receiver errors (10s timeout
 * threshold) — the same `X-GitHub-Delivery` UUID arrives multiple times
 * and, without a guard, the queue producer would enqueue the same review
 * twice and double-post. We persist each delivery id under a unique
 * constraint so the second insert fails predictably and we short-circuit.
 *
 * The table is opportunistically purged of rows older than 24h on every
 * successful insert to keep it bounded without a background sweeper.
 */
import { prisma } from "../../prisma.js";

export interface DeliveryRecord {
  deliveryId: string;
  eventType: string;
  runId?: string | null;
}

export interface DedupResult {
  /** True when the delivery was already recorded (caller should skip). */
  duplicate: boolean;
  /** The delivery id that was checked. */
  deliveryId: string;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function table(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any).prReviewWebhookDelivery;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "P2002") return true;
  if (typeof e.message === "string" && /UNIQUE constraint failed|duplicate key/i.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * Record a webhook delivery. Returns `{ duplicate: true }` when the same
 * `deliveryId` was already stored (the caller MUST skip enqueueing).
 *
 * Empty / whitespace `deliveryId` is treated as non-deduplicatable — we
 * always pass it through and never insert a row, so the legacy
 * synchronous code path stays observable in tests that don't supply
 * delivery headers.
 */
export async function recordDelivery(input: DeliveryRecord): Promise<DedupResult> {
  const id = input.deliveryId.trim();
  if (!id) return { duplicate: false, deliveryId: "" };
  try {
    await table().create({
      data: {
        deliveryId: id,
        eventType: input.eventType,
        runId: input.runId ?? null,
      },
    });
    return { duplicate: false, deliveryId: id };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { duplicate: true, deliveryId: id };
    }
    throw err;
  }
}

/**
 * Update the `runId` pointer for a previously-recorded delivery. Used so
 * the dedup row links back to the AgentRun the worker created.
 */
export async function attachRunId(deliveryId: string, runId: string): Promise<void> {
  const id = deliveryId.trim();
  if (!id) return;
  await table().updateMany({
    where: { deliveryId: id },
    data: { runId },
  });
}

/**
 * Drop dedup rows older than `retentionMs` (default 24h). Best-effort —
 * called opportunistically from `recordDelivery` so the table doesn't
 * grow unbounded between background sweeps.
 */
export async function purgeOldDeliveries(
  retentionMs: number = DEFAULT_RETENTION_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs);
  const result = await table().deleteMany({
    where: { receivedAt: { lt: cutoff } },
  });
  return Number(result?.count ?? 0);
}
