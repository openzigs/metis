/**
 * FinOps → Slack alert channel (Issue #51 / epic #63).
 *
 * Posts a budget-threshold alert to a workspace's configured Slack channel as a
 * Block Kit message. It REUSES the #579 Slack app end to end and does NOT create
 * a second app:
 *   - the per-(workspace) bot token is resolved from the #579
 *     {@link SlackInstallationStore} (vault-backed, never logged);
 *   - the message is formatted with the #579 `block-kit.ts` builders;
 *   - it is posted with the SAME `@slack/web-api` `WebClient` the OAuth flow uses.
 *
 * PER-WORKSPACE ISOLATION: the bot token is looked up by the notification's
 * `workspaceId`, so a workspace's budget alert can only ever be posted with that
 * workspace's own Slack credentials — one tenant can never post into another's
 * Slack.
 *
 * NO-OP (not crash) when the workspace has no active Slack install: the dispatcher
 * records the channel result as a logged no-op failure, exactly like a webhook with
 * no signing secret. The Slack API/token/network are all injectable so this module
 * is fully unit-testable without a live Slack workspace.
 */
import type { AlertNotification } from "../alert-engine.js";
import { buildBudgetAlertBlocks, type Block } from "../../slack/block-kit.js";
import {
  getSlackInstallationStore,
  type SlackInstallationStore,
} from "../../slack/installation-store.js";

/** Result of a single Slack post attempt. */
export interface SlackSendResult {
  ok: boolean;
  error?: string;
}

/** The minimal Slack post surface (`chat.postMessage`) the sender needs. */
export type SlackPostMessage = (args: {
  token: string;
  channel: string;
  blocks: Block[];
  text: string;
}) => Promise<{ ok: boolean; error?: string }>;

export interface SlackSenderDeps {
  /** Store that resolves the per-workspace vault-backed bot token. */
  store?: SlackInstallationStore;
  /** Injected `chat.postMessage`. Defaults to the real `@slack/web-api` call. */
  postMessage?: SlackPostMessage;
}

/** The real `chat.postMessage` transport (lazy-imports `@slack/web-api`). */
const defaultPostMessage: SlackPostMessage = async ({ token, channel, blocks, text }) => {
  const { WebClient } = await import("@slack/web-api");
  const client = new WebClient(token);
  // Blocks are loosely-typed METIS `Block`s (arbitrary Slack JSON); the SDK's
  // strict KnownBlock union is a superset, so cast at this boundary only.
  const res = await client.chat.postMessage({
    channel,
    blocks: blocks as never,
    text,
  });
  return { ok: Boolean(res.ok), error: (res as { error?: string }).error };
};

/**
 * Send a budget-alert Block Kit message to `channel` for the notification's
 * workspace. Resolves the workspace bot token from the install store (no active
 * install → `{ ok:false }` no-op, logged by the dispatcher). Never throws for a
 * missing install; a genuine transport error propagates and is caught by the
 * dispatcher's per-channel wrapper.
 */
export async function sendSlackAlert(
  notification: AlertNotification,
  channel: string,
  deps: SlackSenderDeps = {},
): Promise<SlackSendResult> {
  const target = (channel ?? "").trim();
  if (!target) {
    return { ok: false, error: "slack channel has no target channel id" };
  }

  const store = deps.store ?? getSlackInstallationStore();
  const creds = await store.resolveBotToken(notification.workspaceId);
  if (!creds) {
    return { ok: false, error: "no active Slack installation for workspace" };
  }

  const blocks = buildBudgetAlertBlocks({
    workspaceName: notification.workspaceName,
    ruleName: notification.ruleName,
    thresholdPct: notification.thresholdPct,
    basis: notification.basis,
    spendCents: notification.spendCents,
    budgetCents: notification.budgetCents,
    ratio: notification.ratio,
    firedAt: notification.firedAt,
  });
  // `text` is the notification fallback (screen readers / push previews).
  const pct = Math.round(notification.ratio * 100);
  const fallback = `Budget alert — ${notification.workspaceName}: ${notification.ruleName} at ${pct}% of budget`;

  const postMessage = deps.postMessage ?? defaultPostMessage;
  const res = await postMessage({ token: creds.botToken, channel: target, blocks, text: fallback });
  return { ok: Boolean(res.ok), error: res.ok ? undefined : (res.error ?? "slack post failed") };
}
