/**
 * #1506 — the key a webhook delivery id is deduplicated under in
 * `pr_review_webhook_deliveries` (`agents/pr-reviewer/webhook-dedup.ts`).
 *
 * GitHub gives ONE `X-GitHub-Delivery` GUID to every webhook subscribed to an
 * event ("shared with all deliveries for all webhooks that subscribe to this
 * event", `hook-delivery-item.guid`). Keyed on the bare GUID, the second
 * webhook's delivery of an event read as a duplicate of the first's and was
 * dropped: a repository with both the deployment-secret hook and a
 * per-connector hook (#1475), or with two projects' own hooks, lost every
 * event after the first for one of them.
 *
 * So the key names the receiver and the signer, the webhook the delivery came
 * through, as the trigger receiver already did (#1492):
 *
 *   github-pr:deployment:<guid>        `/github/pr` (deployment secret)
 *   github-pr:c:<connectorId>:<guid>   `/github/pr/c/:connectorId`
 *   github-issues:deployment:<guid>    `/github/issues`
 *   github-issues:c:<connectorId>:<guid>
 *   jira-issues:deployment:<id>        `/jira/issues`
 *   github-trigger:<triggerId>:<guid>  `/github` triggers (#1492, built in `routes/triggers.ts`)
 *
 * The prefixes are disjoint, `deployment` never starts with `c:`, and the id
 * is the last segment, so no two receivers or signers share a key. GitHub's
 * retry of one webhook's delivery keeps its GUID and reaches the same receiver
 * under the same secret, so it maps to the same key and is still deduped.
 *
 * No migration: rows recorded before this change hold the bare id, which no
 * scoped key equals, and they are purged after 24 hours (`purgeOldDeliveries`).
 */

/** Who signed a delivery: the deployment's shared secret, or one connector's own. */
export type DeliverySignerScope =
  { kind: "deployment" } | { kind: "connector"; connectorId: string };

/** The receivers that dedup through this key (the trigger receiver builds its own). */
export type DeliveryReceiver = "github-pr" | "github-issues" | "jira-issues";

/**
 * The dedup key for `rawId` at `receiver` under `signer`. An empty (or
 * whitespace) id returns `""`, which `recordDelivery` treats as "no id": never
 * recorded, never deduped, as before.
 */
export function deliveryDedupKey(
  receiver: DeliveryReceiver,
  signer: DeliverySignerScope,
  rawId: string,
): string {
  const id = rawId.trim();
  if (!id) return "";
  const scope = signer.kind === "connector" ? `c:${signer.connectorId}` : "deployment";
  return `${receiver}:${scope}:${id}`;
}
