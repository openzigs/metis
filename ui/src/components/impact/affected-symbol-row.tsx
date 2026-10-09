/**
 * AffectedSymbolRow — Epic #159 (#165).
 *
 * Renders a single affected code symbol with its relation, depth and
 * confidence. Pure presentational component.
 *
 * #992 — there is no in-app symbol view, so when the caller knows the project's
 * single GitHub / GitHub Enterprise repo the symbol name links to its file:line
 * on that host, at the connector's last indexed commit (else its branch) — the
 * graph the impact was computed from. Without a repo, or for an unsafe path, it
 * stays plain text.
 */
"use client";

import type { ImpactAffectedSymbolView } from "@metis/shared";
import { Badge } from "@/components/ui/badge";
import { buildCodeCitationBlobUrl, type CodeCitationRepo } from "@/lib/code-citation-blob-url";

const RELATION_LABEL: Record<ImpactAffectedSymbolView["relation"], string> = {
  direct: "Direct",
  caller: "Caller",
  importer: "Importer",
  dependency: "Dependency",
  "data-writer": "Writes affected data",
};

export interface AffectedSymbolRowProps {
  symbol: ImpactAffectedSymbolView;
  /** #992 — the project's repo; when set, the symbol links to its file:line there. */
  repo?: CodeCitationRepo | null;
}

export function AffectedSymbolRow({ symbol, repo }: AffectedSymbolRowProps) {
  const lines =
    symbol.startLine != null
      ? `:${symbol.startLine}${symbol.endLine != null ? `-${symbol.endLine}` : ""}`
      : "";
  // A null line range yields no `#L` fragment, so the link opens the file.
  const href = buildCodeCitationBlobUrl(repo, {
    filePath: symbol.filePath,
    startLine: symbol.startLine ?? 0,
    endLine: symbol.endLine ?? 0,
  });

  return (
    <li
      className="flex items-center justify-between gap-3 rounded border px-3 py-2 text-sm"
      data-testid="affected-symbol-row"
      data-relation={symbol.relation}
    >
      <div className="min-w-0">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate font-mono text-xs underline-offset-2 hover:underline"
            title={`${symbol.qualifiedName} — open ${symbol.filePath}${lines} on GitHub`}
            data-testid="affected-symbol-link"
          >
            {symbol.qualifiedName}
          </a>
        ) : (
          <p className="truncate font-mono text-xs" title={symbol.qualifiedName}>
            {symbol.qualifiedName}
          </p>
        )}
        <p className="truncate text-xs text-muted-foreground" title={symbol.filePath}>
          {symbol.filePath}
          {lines}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline" data-testid="affected-symbol-relation">
          {RELATION_LABEL[symbol.relation]}
        </Badge>
        <span className="text-xs text-muted-foreground" data-testid="affected-symbol-depth">
          depth {symbol.depth}
        </span>
        <span className="text-xs text-muted-foreground">
          {Math.round(symbol.confidence * 100)}%
        </span>
      </div>
    </li>
  );
}
