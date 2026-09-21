/**
 * AffectedSymbolRow — Epic #159 (#165).
 *
 * Renders a single affected code symbol with its relation, depth and
 * confidence. Pure presentational component.
 */
"use client";

import type { ImpactAffectedSymbolView } from "@metis/shared";
import { Badge } from "@/components/ui/badge";

const RELATION_LABEL: Record<ImpactAffectedSymbolView["relation"], string> = {
  direct: "Direct",
  caller: "Caller",
  importer: "Importer",
  dependency: "Dependency",
};

export interface AffectedSymbolRowProps {
  symbol: ImpactAffectedSymbolView;
}

export function AffectedSymbolRow({ symbol }: AffectedSymbolRowProps) {
  const lines =
    symbol.startLine != null
      ? `:${symbol.startLine}${symbol.endLine != null ? `-${symbol.endLine}` : ""}`
      : "";

  return (
    <li
      className="flex items-center justify-between gap-3 rounded border px-3 py-2 text-sm"
      data-testid="affected-symbol-row"
      data-relation={symbol.relation}
    >
      <div className="min-w-0">
        <p className="truncate font-mono text-xs" title={symbol.qualifiedName}>
          {symbol.qualifiedName}
        </p>
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
