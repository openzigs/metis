"use client";

/**
 * Epic #726 (#734) — render a code evidence citation on a finding card as its
 * `filePath:startLine-endLine` locator (chat's #715 grounding format), visually
 * distinct from document citations (monospace + a "code" badge) with a
 * copy-to-clipboard affordance.
 *
 * There is no in-app repository file viewer (verified 2026-07). #728 — when the
 * page provides the project's single GitHub / GitHub Enterprise repo
 * (`CodeCitationRepoContext`), the locator links to the file's blob at the
 * connector's commit SHA (else its branch/ref) in a new tab. Otherwise — no
 * provider, a non-GitHub connector, several candidate repos, or an unsafe path —
 * it stays non-link text. The copy button remains either way, so an analyst can
 * paste the locator into an editor / `git blame`.
 */
import { formatCodeCitationLocator, type AnalysisCodeCitation } from "@/lib/analysis-api";
import { buildCodeCitationBlobUrl } from "@/lib/code-citation-blob-url";
import { useCodeCitationRepoContext } from "./code-citation-repo-context";
import { useTransientFlag } from "@/hooks/use-transient-toast";

export function CodeCitation({ citation }: { citation: AnalysisCodeCitation }) {
  // #1284 — the hook owns the 1.5s dismissal timer AND cancels it on unmount.
  const { active: copied, show: showCopied } = useTransientFlag(1500);
  const locator = formatCodeCitationLocator(citation);
  const href = buildCodeCitationBlobUrl(useCodeCitationRepoContext(), citation);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(locator);
      showCopied();
    } catch {
      // Clipboard can be unavailable (insecure context / denied permission);
      // the locator stays selectable as text, so degrade silently.
    }
  }

  return (
    <li className="flex items-center gap-1.5">
      <span
        className="rounded bg-info-muted px-1 text-[10px] font-medium uppercase tracking-wide text-info"
        data-testid="code-citation-badge"
      >
        code
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline-offset-2 hover:underline"
          title={citation.symbolId ? `${citation.symbolId} — open on GitHub` : "Open on GitHub"}
          data-testid="code-citation-link"
        >
          <code className="font-mono">{locator}</code>
        </a>
      ) : (
        <code className="font-mono text-foreground" title={citation.symbolId ?? locator}>
          {locator}
        </code>
      )}
      <button
        type="button"
        onClick={handleCopy}
        className="text-muted-foreground hover:text-foreground"
        aria-label={`Copy ${locator}`}
        data-testid="code-citation-copy"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </li>
  );
}
