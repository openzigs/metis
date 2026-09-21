/**
 * Issue #579 (epic #63) — Slack Block Kit message builders for METIS ChatOps.
 *
 * Pure, side-effect-free functions that produce the Block Kit JSON for the
 * `/metis status` health message, the `/metis approve` interactive prompt (with
 * an Approve button), and the various refusal/confirmation messages. They are the
 * Slack analogue of the #578 Teams Adaptive-Card builders.
 *
 * EPHEMERAL: unlike Teams, Slack HAS first-class ephemeral responses — a slash
 * command can reply with `response_type: "ephemeral"` so only the invoking user
 * sees it. The status + refusal messages use it so a channel never sees another
 * user's project health or an authorization refusal. (The receiver wiring in
 * `bolt-app.ts` passes these block sets to `respond({ response_type, blocks })`.)
 *
 * The Approve button carries an `action_id` (`metis_approve_draft`) and a `value`
 * of the draft id; pressing it sends an interactive payload the receiver routes to
 * `handleSlackApproveAction`. The draft id in the button value is UNTRUSTED on the
 * way back — the action handler re-runs the FULL authz chain (it never trusts the
 * prompt that produced the button).
 */
import type { ProjectHealthSummary } from "../teams/project-health.js";

/** The interactive Approve button's `action_id` (echoed in the action payload). */
export const APPROVE_ACTION_ID = "metis_approve_draft";

/** A Block Kit block (loosely typed — Slack accepts arbitrary block JSON). */
export type Block = Record<string, unknown>;

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function header(text: string): Block {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function context(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/** A clear refusal/error message. `detail` is always a safe, user-facing string. */
export function buildErrorBlocks(title: string, detail: string): Block[] {
  return [section(`:warning: *${title}*`), section(detail)];
}

/** The project-health blocks for `/metis status`. */
export function buildStatusBlocks(health: ProjectHealthSummary): Block[] {
  const fields = [
    `*Project status*\n${health.status}`,
    `*Requirements*\n${health.requirementCount}`,
    `*Drafts*\n${health.drafts.pending} pending · ${health.drafts.approved} approved · ${health.drafts.published} published`,
    `*Latest analysis*\n${health.latestAnalysisStatus ?? "none yet"}`,
    `*Latest publish*\n${health.latestPublishStatus ?? "none yet"}`,
  ];
  return [
    header(`:bar_chart: ${health.name}`),
    {
      type: "section",
      fields: fields.map((text) => ({ type: "mrkdwn", text })),
    },
  ];
}

/** The approve-prompt blocks carrying the interactive Approve button. */
export function buildApprovePromptBlocks(draft: { id: string; title: string }): Block[] {
  return [
    section("*Approve draft?*"),
    section(draft.title),
    context(`Draft \`${draft.id}\``),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve", emoji: true },
          action_id: APPROVE_ACTION_ID,
          // The draft id is echoed back on click — UNTRUSTED, re-authorized then.
          value: draft.id,
        },
      ],
    },
  ];
}

/** Confirmation blocks — the draft was approved. */
export function buildApprovedBlocks(draftId: string): Block[] {
  return [
    section(":white_check_mark: *Draft approved*"),
    section(`Draft \`${draftId}\` is now approved in METIS.`),
  ];
}

/** Summary shape for a FinOps budget-alert Block Kit message (#51). */
export interface BudgetAlertSummary {
  workspaceName: string;
  ruleName: string;
  thresholdPct: number;
  /** "mtd" | "projected". */
  basis: string;
  spendCents: number;
  budgetCents: number;
  /** Utilisation fraction (spend/budget). */
  ratio: number;
  firedAt: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Block Kit blocks for a FinOps budget-threshold alert (#51). Mirrors the email
 * body / webhook payload the #50 dispatcher already builds, rendered as a Slack
 * card. All values are numeric/enum from the alert engine — no untrusted free
 * text — so mrkdwn injection is not a concern.
 */
export function buildBudgetAlertBlocks(a: BudgetAlertSummary): Block[] {
  const pct = Math.round(a.ratio * 100);
  const fields = [
    `*Threshold*\n${a.thresholdPct}% (${a.basis})`,
    `*Utilisation*\n${pct}%`,
    `*Spend*\n${formatCents(a.spendCents)}`,
    `*Budget*\n${formatCents(a.budgetCents)}`,
  ];
  return [
    header(`:rotating_light: Budget alert — ${a.workspaceName}`),
    section(`Rule *${a.ruleName}* tripped at *${pct}%* of the monthly budget.`),
    {
      type: "section",
      fields: fields.map((text) => ({ type: "mrkdwn", text })),
    },
    context(`Fired at ${a.firedAt}`),
  ];
}

const HELP_TEXT =
  "Available commands:\n" +
  "• `/metis status [<projectId>]` — show project health\n" +
  "• `/metis approve <draftId>` — start an approval for a publishing draft";

/** Help blocks listing the available commands + exact invocation syntax. */
export function buildHelpBlocks(): Block[] {
  return [section("*METIS ChatOps*"), section(HELP_TEXT)];
}
