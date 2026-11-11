"use client";

/**
 * #2242 — under a chat reply: every citation it made, checked against what its
 * turn retrieved or read. A verified citation of the project's code links to
 * the file on GitHub at the lines it cites; one that does not resolve is
 * marked, so a fabricated `file:line` no longer reads like a real one.
 */
import type { ChatCitation } from "@/lib/ai-client";
import { buildCodeCitationBlobUrl, type CodeCitationRepo } from "@/lib/code-citation-blob-url";
import { useCodeCitationRepo } from "@/components/findings/code-citation-repo-context";

const NOTE: Record<ChatCitation["status"], string> = {
  verified: "in the sources this reply read",
  "span-unverified": "the file was read, but not these lines",
  "not-read": "not in anything this reply retrieved or read",
};

const MARK: Record<ChatCitation["status"], string> = {
  verified: "✓",
  "span-unverified": "⚠",
  "not-read": "✗",
};

/** The summary line: how many citations resolved and how many did not. */
export function citationSummary(citations: readonly ChatCitation[]): string {
  const verified = citations.filter((c) => c.status === "verified").length;
  const unverified = citations.length - verified;
  const parts = [`Citations · ${verified} verified`];
  if (unverified > 0) parts.push(`${unverified} not verified`);
  return parts.join(" · ");
}

/** A link to a verified citation of the project's code, or `null` when it cannot have one. */
export function citationHref(c: ChatCitation, repo: CodeCitationRepo | null): string | null {
  if (c.status !== "verified" || c.source !== "repo") return null;
  return buildCodeCitationBlobUrl(repo, {
    filePath: c.path,
    startLine: c.lines?.[0] ?? 0,
    endLine: c.lines?.[1] ?? 0,
  });
}

/**
 * Under a reply: its citations, linked into the project's GitHub repo. The repo
 * is looked up only for a reply that cited something.
 */
export function CitationList({
  citations,
  projectId,
}: {
  citations: readonly ChatCitation[] | undefined;
  projectId: string | null | undefined;
}) {
  if (!citations || citations.length === 0) return null;
  return <LinkedCitations citations={citations} projectId={projectId} />;
}

function LinkedCitations({
  citations,
  projectId,
}: {
  citations: readonly ChatCitation[];
  projectId: string | null | undefined;
}) {
  const repo = useCodeCitationRepo(projectId);
  return <CitationListView citations={citations} repo={repo} />;
}

/** The list itself, given the repo its code citations link into. */
export function CitationListView({
  citations,
  repo,
}: {
  citations: readonly ChatCitation[];
  repo: CodeCitationRepo | null;
}) {
  if (citations.length === 0) return null;
  const problems = citations.some((c) => c.status !== "verified");
  return (
    <details
      data-testid="chat-citations"
      open={problems}
      className={`mt-1 text-xs ${problems ? "text-warning" : "text-muted-foreground"}`}
    >
      <summary className="cursor-pointer">{citationSummary(citations)}</summary>
      <ul className="mt-1 space-y-0.5 pl-1">
        {citations.map((c) => {
          const href = citationHref(c, repo);
          return (
            <li key={`${c.text}|${c.path}`} data-testid="chat-citation" data-status={c.status}>
              <span aria-hidden="true">{MARK[c.status]} </span>
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono underline underline-offset-2"
                >
                  {c.text}
                </a>
              ) : (
                <span className="font-mono">{c.text}</span>
              )}
              {/* What a short or `[n]` citation resolved to. */}
              {c.path && !c.text.startsWith(c.path) ? (
                <span className="font-mono"> → {c.path}</span>
              ) : null}
              {` — ${NOTE[c.status]}`}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
