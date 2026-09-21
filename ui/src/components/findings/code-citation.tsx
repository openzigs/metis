"use client";

/**
 * Epic #726 (#734) — render a code evidence citation on a finding card as its
 * `filePath:startLine-endLine` locator (chat's #715 grounding format), visually
 * distinct from document citations (monospace + a "code" badge) with a
 * copy-to-clipboard affordance.
 *
 * There is no in-app repository file viewer (verified 2026-07), so the locator
 * is rendered as non-link text; the copy button lets an analyst paste it into an
 * editor / `git blame`. If a future connector exposes a remote blob URL this is
 * the single place to make the locator a link.
 */
import { formatCodeCitationLocator, type AnalysisCodeCitation } from "@/lib/analysis-api";
import { useTransientFlag } from "@/hooks/use-transient-toast";

export function CodeCitation({ citation }: { citation: AnalysisCodeCitation }) {
  // #1284 — the hook owns the 1.5s dismissal timer AND cancels it on unmount.
  const { active: copied, show: showCopied } = useTransientFlag(1500);
  const locator = formatCodeCitationLocator(citation);

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
        className="rounded bg-sky-500/10 px-1 text-[10px] font-medium uppercase tracking-wide text-sky-300"
        data-testid="code-citation-badge"
      >
        code
      </span>
      <code className="font-mono text-zinc-300" title={citation.symbolId ?? locator}>
        {locator}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="text-zinc-500 hover:text-zinc-300"
        aria-label={`Copy ${locator}`}
        data-testid="code-citation-copy"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </li>
  );
}
