/**
 * Issue #67 — render ONE-WAY Teams notification cards.
 *
 * These are standalone NOTIFICATION cards for three operational events
 * (analysis-complete, publish-rolled-back, budget-exceeded). They are distinct
 * from:
 *   - the discussion-message mirror cards (#550/#553 `outbound-render.ts`), which
 *     carry a "Promote to requirement" Action.Submit tied to a DiscussionMessage;
 *   - the ChatOps cards (#578 `teams-command.ts`), which carry approval buttons.
 * A notification card has NO actions — it is informational only (the scope split
 * in #63: #67 owns one-way notifications, #578 owns interactive ChatOps).
 *
 * This module is a PURE formatter (no I/O, no Prisma, no SDK calls beyond the
 * botbuilder `Activity`/`Attachment` types) so every branch is trivially
 * unit-testable. Each builder returns a `Partial<Activity>` carrying:
 *   - a `text` fallback so a client that does not render Adaptive Cards still
 *     shows a readable line, and
 *   - an Adaptive Card attachment with a titled `FactSet`/`TextBlock` layout.
 *
 * SECURITY (OWASP A01/A09 — no cross-tenant/PII leakage): every value rendered
 * here is supplied by the caller from the originating event's OWN workspace data.
 * The renderer never reaches into other workspaces and never logs. Free-text
 * fields are length-clamped (defence against an oversized payload making the
 * proactive send throw), but NOT used to build any code/markup — Teams renders a
 * constrained markdown subset and treats card text as data.
 */
import type { Activity, Attachment } from "botbuilder";

/** The Adaptive Card content-type Teams expects on an attachment. */
const ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

/** Clamp a single field so a hostile/oversized value can't break the send. */
const FIELD_MAX = 512;
function clamp(value: string, max: number = FIELD_MAX): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** A single label/value row in the card's FactSet. */
interface Fact {
  title: string;
  value: string;
}

/** Inputs for the analysis-complete notification. */
export interface AnalysisCompletePayload {
  projectName: string;
  analysisId: string;
  /** Optional human-friendly counts (requirements/findings), if known. */
  requirementCount?: number | null;
  findingCount?: number | null;
}

/** Inputs for the publish-rolled-back notification. */
export interface PublishRolledBackPayload {
  projectName: string;
  batchId: string;
  /** Why the rollback happened (e.g. "auto-rollback: 3/5 drafts failed"). */
  reason: string;
  /** Repo the batch targeted, e.g. "owner/repo" (optional). */
  repo?: string | null;
}

/** Inputs for the budget-exceeded notification. */
export interface BudgetExceededPayload {
  workspaceName: string;
  ruleName: string;
  /** "actual" | "projected" — which spend basis tripped the rule. */
  basis: string;
  spendCents: number;
  budgetCents: number;
  /** spend / budget ratio (e.g. 1.12 = 112% of budget). */
  ratio: number;
}

/** Format a cents amount as a plain USD string (no locale lookup; deterministic). */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

/** Build a titled Adaptive Card with a header line and a FactSet body. */
function buildCard(title: string, subtitle: string, facts: Fact[]): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: clamp(title, 120),
        weight: "Bolder",
        size: "Medium",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: clamp(subtitle, 256),
        isSubtle: true,
        wrap: true,
        spacing: "None",
      },
      {
        type: "FactSet",
        facts: facts.map((f) => ({ title: clamp(f.title, 80), value: clamp(f.value) })),
      },
    ],
  };
}

/** Wrap a card + fallback text into a proactive `message` activity. */
function asActivity(text: string, card: Record<string, unknown>): Partial<Activity> {
  const attachment: Attachment = {
    contentType: ADAPTIVE_CARD_CONTENT_TYPE,
    content: card,
  };
  return { type: "message", text: clamp(text, 1024), attachments: [attachment] };
}

/** Render the analysis-complete notification card. */
export function renderAnalysisCompleteCard(p: AnalysisCompletePayload): Partial<Activity> {
  const facts: Fact[] = [{ title: "Project", value: p.projectName }];
  if (typeof p.requirementCount === "number") {
    facts.push({ title: "Requirements", value: String(p.requirementCount) });
  }
  if (typeof p.findingCount === "number") {
    facts.push({ title: "Findings", value: String(p.findingCount) });
  }
  const card = buildCard(
    "✅ Analysis complete",
    `METIS finished analysing ${clamp(p.projectName, 120)}.`,
    facts,
  );
  return asActivity(`✅ METIS analysis complete for ${p.projectName}`, card);
}

/** Render the publish-rolled-back notification card. */
export function renderPublishRolledBackCard(p: PublishRolledBackPayload): Partial<Activity> {
  const facts: Fact[] = [
    { title: "Project", value: p.projectName },
    { title: "Reason", value: p.reason },
  ];
  if (p.repo) facts.push({ title: "Repository", value: p.repo });
  const card = buildCard(
    "⛔ Publish rolled back",
    `A publishing batch for ${clamp(p.projectName, 120)} was rolled back.`,
    facts,
  );
  return asActivity(`⛔ METIS publish rolled back for ${p.projectName}: ${p.reason}`, card);
}

/** Render the budget-exceeded notification card. */
export function renderBudgetExceededCard(p: BudgetExceededPayload): Partial<Activity> {
  const pct = `${Math.round(p.ratio * 100)}%`;
  const facts: Fact[] = [
    { title: "Workspace", value: p.workspaceName },
    { title: "Rule", value: p.ruleName },
    { title: "Basis", value: p.basis },
    { title: "Spend", value: `${formatCents(p.spendCents)} of ${formatCents(p.budgetCents)}` },
    { title: "Utilization", value: pct },
  ];
  const card = buildCard(
    "💸 Budget threshold exceeded",
    `Spend in ${clamp(p.workspaceName, 120)} has crossed a configured budget alert.`,
    facts,
  );
  return asActivity(
    `💸 METIS budget alert for ${p.workspaceName}: ${pct} of budget (${p.basis})`,
    card,
  );
}
