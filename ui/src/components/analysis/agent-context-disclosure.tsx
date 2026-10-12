"use client";

/**
 * Issue #1027 (review) — the context text the code agent was given, on the
 * analysis page.
 *
 * A run can carry `agentContext`: background the code agent reads beside the
 * requirements. A Spec Kit handoff fills it, and its notice names the plan
 * components and tasks it sent, but those are labels; and any caller with
 * `analysis.run` can send the field with no handoff record at all. Until this
 * existed nothing on the page showed the text, so a run could be steered by
 * words no one looking at it could see.
 *
 * Shown for every run that has a context, whatever started it. Collapsed by
 * default, because it is up to 4,096 characters of background. The text is
 * untrusted (a person or a model wrote it), so it is rendered as plain text in
 * a `<pre>`: never as Markdown, never as HTML.
 */

/** The run's stored context, or null when it has none. */
export function agentContextOf(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const value = metadata?.agentContext;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

export function AgentContextDisclosure({
  metadata,
}: {
  metadata: Record<string, unknown> | null | undefined;
}): React.ReactElement | null {
  const text = agentContextOf(metadata);
  if (text === null) return null;
  return (
    <details data-testid="analysis-agent-context" className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Context given to the code agent, not requirements ({text.length.toLocaleString("en-US")}{" "}
        {text.length === 1 ? "character" : "characters"})
      </summary>
      <p className="mt-1 text-muted-foreground">
        Background the code agent read beside the requirements. It is not analysed as a requirement
        and is shown exactly as it was stored.
      </p>
      <pre
        data-testid="analysis-agent-context-text"
        className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border p-2 font-mono"
      >
        {text}
      </pre>
    </details>
  );
}
