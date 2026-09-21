/**
 * Alert channel dispatcher (Epic #47 / Issue #50).
 *
 * Bridges the alert engine (#49) to the email + webhook transports. Builds a
 * human-readable email body and a structured JSON webhook payload from an
 * `AlertNotification`, fans out to every configured channel, and returns one
 * `DeliveryResult` per channel. A single channel failure never aborts the
 * others (each is wrapped).
 */
import type {
  AlertChannelRow,
  AlertDispatcher,
  AlertNotification,
  DeliveryResult,
} from "../alert-engine.js";
import { shouldNotifyEmailRecipient } from "../../notifications/preferences.js";
import { resolveEmailSender, type EmailSender } from "./email-sender.js";
import { sendWebhook } from "./webhook-sender.js";
import { sendSlackAlert, type SlackSenderDeps } from "./slack-sender.js";
import { sendPagerDutyAlert, type PagerDutySenderDeps } from "./pagerduty-sender.js";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function buildEmailBody(n: AlertNotification): { subject: string; text: string } {
  const pct = Math.round(n.ratio * 100);
  const subject = `[METIS FinOps] ${n.workspaceName}: ${n.ruleName} (${pct}% of budget)`;
  const text = [
    `Workspace "${n.workspaceName}" has tripped the budget alert rule "${n.ruleName}".`,
    ``,
    `Threshold:   ${n.thresholdPct}% (${n.basis})`,
    `Spend:       ${formatCents(n.spendCents)}`,
    `Budget:      ${formatCents(n.budgetCents)}`,
    `Utilisation: ${pct}%`,
    `Fired at:    ${n.firedAt}`,
  ].join("\n");
  return { subject, text };
}

export function buildWebhookPayload(n: AlertNotification): Record<string, unknown> {
  return {
    type: "finops.budget_alert",
    workspaceId: n.workspaceId,
    workspaceName: n.workspaceName,
    rule: n.ruleName,
    thresholdPct: n.thresholdPct,
    basis: n.basis,
    spendCents: n.spendCents,
    budgetCents: n.budgetCents,
    ratio: n.ratio,
    firedAt: n.firedAt,
  };
}

/**
 * Parse a channel's `config` JSON blob defensively. Untrusted stored text: a
 * malformed/empty blob yields `{}` rather than throwing (a bad config must not
 * break the dispatch of the OTHER channels).
 */
function parseConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function dispatchOne(
  channel: AlertChannelRow,
  notification: AlertNotification,
  emailSender: EmailSender,
  slackDeps: SlackSenderDeps,
  pagerDutyDeps: PagerDutySenderDeps,
): Promise<DeliveryResult> {
  try {
    if (channel.type === "email") {
      // #614 — when the target address maps to an active METIS user, that
      // user's `email × systemAlerts` preference governs the send. Non-user
      // recipients (dist lists, shared mailboxes) are preference-exempt — see
      // NOTIFICATION_PREFERENCE_EXEMPTIONS ("finops-non-user-recipients").
      // The helper never throws and fails OPEN (send).
      if (!(await shouldNotifyEmailRecipient(channel.target, "systemAlerts"))) {
        return { channelId: channel.id, type: channel.type, ok: true, suppressed: true };
      }
      const { subject, text } = buildEmailBody(notification);
      const r = await emailSender.send({ to: channel.target, subject, text });
      return { channelId: channel.id, type: channel.type, ok: r.ok, error: r.error };
    }
    // #614 — webhook + slack channels are preference-EXEMPT: the recipient is a
    // shared endpoint (URL / Slack channel), never an individual METIS user.
    // See NOTIFICATION_PREFERENCE_EXEMPTIONS ("finops-non-user-recipients").
    if (channel.type === "webhook") {
      if (!channel.secret) {
        return {
          channelId: channel.id,
          type: channel.type,
          ok: false,
          error: "webhook channel has no signing secret",
        };
      }
      const r = await sendWebhook({
        url: channel.target,
        secret: channel.secret,
        payload: buildWebhookPayload(notification),
      });
      return { channelId: channel.id, type: channel.type, ok: r.ok, error: r.error };
    }
    if (channel.type === "slack") {
      // Slack: `target` is the channel id/name; `config.channel` may override it.
      // The per-workspace vault-backed bot token is resolved inside the sender.
      const cfg = parseConfig(channel.config);
      const slackChannel =
        typeof cfg.channel === "string" && cfg.channel.trim() ? cfg.channel : channel.target;
      const r = await sendSlackAlert(notification, slackChannel, slackDeps);
      return { channelId: channel.id, type: channel.type, ok: r.ok, error: r.error };
    }
    if (channel.type === "pagerduty") {
      // PagerDuty: the per-workspace routing key is resolved inside the sender via
      // the #580 service-config store, keyed by `config.serviceKey` (default when
      // absent). `target` is not used — the routing key is never client-supplied.
      // #614 — EXEMPT BY DESIGN: PagerDuty severity paths are never
      // preference-suppressed. Do NOT add a shouldNotify call here. See
      // NOTIFICATION_PREFERENCE_EXEMPTIONS ("pagerduty-ops-alerting").
      const cfg = parseConfig(channel.config);
      const serviceKey = typeof cfg.serviceKey === "string" ? cfg.serviceKey : undefined;
      const r = await sendPagerDutyAlert(notification, serviceKey, pagerDutyDeps);
      return { channelId: channel.id, type: channel.type, ok: r.ok, error: r.error };
    }
    return {
      channelId: channel.id,
      type: channel.type,
      ok: false,
      error: `unknown channel type ${channel.type}`,
    };
  } catch (err) {
    return {
      channelId: channel.id,
      type: channel.type,
      ok: false,
      error: (err as Error).message,
    };
  }
}

export interface DispatcherDeps {
  emailSender?: EmailSender;
  /** Injected Slack sender deps (#51) — token store + `chat.postMessage`. */
  slack?: SlackSenderDeps;
  /** Injected PagerDuty sender deps (#51) — Events client + config store. */
  pagerDuty?: PagerDutySenderDeps;
}

/** Build an `AlertDispatcher` bound to the configured transports. */
export function createDispatcher(deps: DispatcherDeps = {}): AlertDispatcher {
  const emailSender = deps.emailSender ?? resolveEmailSender();
  const slackDeps = deps.slack ?? {};
  const pagerDutyDeps = deps.pagerDuty ?? {};
  return async (channels: AlertChannelRow[], notification: AlertNotification) => {
    const results: DeliveryResult[] = [];
    for (const channel of channels) {
      results.push(await dispatchOne(channel, notification, emailSender, slackDeps, pagerDutyDeps));
    }
    return results;
  };
}
