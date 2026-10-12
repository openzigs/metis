"use client";

/**
 * Issue #994 — on the analysis page itself, what a Spec Kit "Start analysis"
 * handoff sent and what it left out. The handoff's toast fired before the
 * redirect and was never seen, so a run that worked from part of the spec
 * looked like one that read all of it.
 *
 * Issue #1027 — the handoff also sends plan.md's components and tasks.md's task
 * titles as context for the code agent. They are shown as context, apart from
 * the requirements from spec.md, with what did not fit the context limit.
 *
 * Reads `metadata.specKitHandoff` (persisted when the run started), so it shows
 * while the run is still going and on every later visit. Renders nothing for a
 * run that was not started from a Spec Kit handoff.
 *
 * The record is written by whoever started the run. The server checks the
 * component and task labels against the context text it stored
 * (`specKitHandoffLabelsNotInContext`), so those name text the code agent was
 * given; it cannot check the list of what was left out, which is therefore
 * shown as reported. The text itself is on the page in `AgentContextDisclosure`,
 * for every run that has one, handoff or not.
 */
import {
  MAX_ANALYSIS_AGENT_CONTEXT,
  specKitHandoffSchema,
  type SpecKitHandoffRecord,
} from "@metis/shared";
import { notSentPhrase } from "@/lib/spec-kit-handoff";

/** The persisted record, or null when absent or malformed. */
export function specKitHandoffOf(
  metadata: Record<string, unknown> | null | undefined,
): SpecKitHandoffRecord | null {
  const parsed = specKitHandoffSchema.safeParse(metadata?.specKitHandoff);
  return parsed.success ? parsed.data : null;
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** `from plan.md: 2 components (A, B); from tasks.md: 1 task (T01)`. */
function contextSummary(context: NonNullable<SpecKitHandoffRecord["context"]>): string {
  return [
    context.components.length > 0
      ? `from plan.md: ${count(context.components.length, "component")} (${context.components.join(", ")})`
      : null,
    context.tasks.length > 0
      ? `from tasks.md: ${count(context.tasks.length, "task")} (${context.tasks.join(", ")})`
      : null,
  ]
    .filter((part) => part !== null)
    .join("; ");
}

export function SpecKitHandoffNotice({
  metadata,
}: {
  metadata: Record<string, unknown> | null | undefined;
}): React.ReactElement | null {
  const handoff = specKitHandoffOf(metadata);
  if (!handoff) return null;
  const { sent, omitted, context } = handoff;
  const contextSent = context ? contextSummary(context) : "";
  // A file nothing was read from is named as not sent; naming it without saying
  // so would imply it was (#994). A handoff from before #1027 sent no context.
  // A file that was read with nothing recognised in it says so: "not read"
  // would be untrue, and would hide that its Markdown is off the template.
  const notSent = notSentPhrase(
    handoff.artifacts,
    [
      ...(context && context.components.length > 0 ? ["plan.md"] : []),
      ...(context && context.tasks.length > 0 ? ["tasks.md"] : []),
    ],
    context?.unrecognised ?? [],
  );
  return (
    <div data-testid="spec-kit-handoff-notice" className="space-y-1 text-xs">
      <p className="text-muted-foreground">
        Started from a Spec Kit handoff. Only spec.md&apos;s requirements were sent.
        {sent.length > 0
          ? ` Sent ${sent.length} requirement${sent.length === 1 ? "" : "s"} from spec.md: ${sent.join(", ")}.`
          : null}
      </p>
      {contextSent ? (
        <p className="text-muted-foreground" data-testid="spec-kit-handoff-context">
          Sent as context for the code agent, not as requirements — {contextSent}.
        </p>
      ) : null}
      {context && context.omitted.length > 0 ? (
        <p className="text-warning" role="status" data-testid="spec-kit-handoff-context-omitted">
          Left out of the context, as reported by the Spec Kit page —{" "}
          {context.omitted.length === 1 ? "it" : "they"} did not fit the{" "}
          {MAX_ANALYSIS_AGENT_CONTEXT.toLocaleString("en-US")}-character context limit:{" "}
          {context.omitted.join(", ")}.
        </p>
      ) : null}
      {notSent.length > 0 ? (
        <p className="text-muted-foreground" data-testid="spec-kit-handoff-context-not-sent">
          Not sent: {notSent}.
        </p>
      ) : null}
      {omitted.length > 0 ? (
        <p className="text-warning" role="status" data-testid="spec-kit-handoff-omitted">
          Not sent — {omitted.length === 1 ? "it" : "they"} did not fit the analysis input limit:{" "}
          {omitted.join(", ")}. This run did not evaluate {omitted.length === 1 ? "it" : "them"}.
        </p>
      ) : null}
    </div>
  );
}
