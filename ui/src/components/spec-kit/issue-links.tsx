"use client";

/**
 * #993 — links to the GitHub issues a Spec Kit export created, for the success
 * toast and the result card. At most {@link MAX_SHOWN} are listed; the rest are
 * counted, so a large export does not bury the page.
 */
import type { CreatedIssueLink } from "@/lib/spec-kit-export";

const MAX_SHOWN = 10;

export function IssueLinks({ links, testId }: { links: CreatedIssueLink[]; testId: string }) {
  const shown = links.slice(0, MAX_SHOWN);
  const more = links.length - shown.length;
  return (
    <ul className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5" data-testid={testId}>
      {shown.map((l) => (
        <li key={l.taskId}>
          <a
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            {l.taskId} #{l.issueNumber}
          </a>
        </li>
      ))}
      {more > 0 ? <li>and {more} more</li> : null}
    </ul>
  );
}
