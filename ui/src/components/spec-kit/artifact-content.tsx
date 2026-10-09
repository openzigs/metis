"use client";

/**
 * #945 — the Spec Kit artifact viewer body. Markdown artifacts are rendered
 * (headings, lists, tables, Mermaid) instead of being shown as raw Markdown in
 * a `<pre>` that did not wrap (340 px of box against 12,490 px of text). The
 * OpenAPI YAML stays text, wrapped. Machine markers are hidden either way.
 */
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { displayArtifactText, isMarkdownArtifact } from "@/lib/spec-kit-display";

interface Props {
  /** The artifact's name or key — `spec.md`, `contracts/api.openapi.yaml`. */
  name: string;
  content: string;
}

export function ArtifactContent({ name, content }: Props) {
  const text = displayArtifactText(content);
  if (!isMarkdownArtifact(name)) {
    return (
      <pre
        className="h-[60vh] w-full overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-3 text-sm"
        data-testid="spec-kit-content"
      >
        {text}
      </pre>
    );
  }
  return (
    <div
      className="h-[60vh] w-full overflow-auto break-words rounded border bg-muted/40 p-3 text-sm [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_table]:block [&_table]:overflow-x-auto"
      data-testid="spec-kit-content"
      data-rendered="markdown"
    >
      <ChatMarkdown content={text} />
    </div>
  );
}
