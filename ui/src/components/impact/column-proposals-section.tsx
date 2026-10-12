/**
 * ColumnProposalsSection — #1051.
 *
 * The proposed columns impact analysis did NOT put among the affected tables
 * (#791), so a reviewer can see what was ruled out and why:
 *
 *   - `optional` — "Optional: settings persistence". A column that would only
 *     remember a preferred value: for an operation that already exists, or
 *     (in a request the gate could not check) one the proposer itself labelled
 *     a preference — that row cites no write path. Shown with its suggested
 *     DDL, labelled as outside the migration the change needs.
 *   - `rejected` — "Not proposed". An existing write path appears to take the
 *     value as a parameter already; each row says what was checked. Shown WITHOUT
 *     DDL: a copyable `ALTER TABLE` under a "not proposed" heading would say the
 *     opposite of the heading.
 *   - `unchecked` — "Proposed, not checked". Different in kind: these columns ARE
 *     among the proposed changes above, and the #791 gate did not rule on them;
 *     each row says why. Shown WITHOUT DDL, which is already in the table above;
 *     this section is the caveat on it.
 *
 * Each row names the covering write path and links it to its file and line when
 * the caller knows the project's repo. Renders nothing for an empty list.
 * Every string is rendered as text: the reason is written by the engine's
 * deterministic gate, and the names come from the repository and the model.
 */
"use client";

import type { ImpactColumnProposalView } from "@metis/shared";
import { buildCodeCitationBlobUrl, type CodeCitationRepo } from "@/lib/code-citation-blob-url";

export type ColumnProposalVariant = "optional" | "rejected" | "unchecked";

const COPY: Record<ColumnProposalVariant, { title: string; note: string; testId: string }> = {
  optional: {
    title: "Optional: settings persistence",
    note: "Not part of the migration this change needs. Either an existing write path may already cover the request, or the model itself classed the column as a remembered preference; each row says which. Add one only to remember a preferred value. If the change does need a column, ask for it in the request: write its ALTER TABLE statement, or a sentence such as \u201cadd a delay field to users\u201d.",
    testId: "optional-column-proposals",
  },
  rejected: {
    title: "Not proposed",
    note: "An existing write path appears to cover these already. Each row says what was checked.",
    testId: "dropped-column-proposals",
  },
  unchecked: {
    title: "Proposed, not checked",
    note: "These columns are in the proposed changes above, but were not checked against the existing write paths. Each row says why. Treat them as unverified.",
    testId: "unchecked-column-proposals",
  },
};

export interface ColumnProposalsSectionProps {
  variant: ColumnProposalVariant;
  proposals: ImpactColumnProposalView[];
  /** The project's repo; when set, the covering write path links to its file:line. */
  repo?: CodeCitationRepo | null;
}

/** `MarkAllAsReadBeforeDate` out of `internal/storage/entry.go::Storage::MarkAllAsReadBeforeDate`. */
function shortName(qualifiedName: string): string {
  const afterFile = qualifiedName.split("::").pop() ?? qualifiedName;
  return afterFile.slice(afterFile.lastIndexOf(".") + 1);
}

export function ColumnProposalsSection({ variant, proposals, repo }: ColumnProposalsSectionProps) {
  if (proposals.length === 0) return null;
  const copy = COPY[variant];

  return (
    <div className="rounded border border-border/60 px-3 py-2" data-testid={copy.testId}>
      <p className="text-xs font-medium text-foreground">
        {copy.title} ({proposals.length})
      </p>
      <p className="mb-2 text-xs text-muted-foreground">{copy.note}</p>
      <ul className="space-y-2">
        {proposals.map((p) => {
          const location = p.writer
            ? `${p.writer.filePath}${p.writer.startLine != null ? `:${p.writer.startLine}` : ""}`
            : null;
          const href = p.writer
            ? buildCodeCitationBlobUrl(repo, {
                filePath: p.writer.filePath,
                startLine: p.writer.startLine ?? 0,
                endLine: p.writer.endLine ?? 0,
              })
            : null;
          return (
            <li key={p.id} className="text-sm" data-testid="column-proposal-row">
              <p>
                <span className="font-mono text-xs" data-testid="column-proposal-column">
                  {p.tableName}.{p.columnName}
                </span>
                {p.columnType ? (
                  <span className="text-xs text-muted-foreground"> {p.columnType}</span>
                ) : null}
              </p>
              {p.writer ? (
                <p className="text-xs text-muted-foreground" data-testid="column-proposal-writer">
                  Existing write path:{" "}
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono underline-offset-2 hover:underline"
                      title={`${p.writer.qualifiedName} — open ${location} on GitHub`}
                    >
                      {shortName(p.writer.qualifiedName)}
                    </a>
                  ) : (
                    <span className="font-mono">{shortName(p.writer.qualifiedName)}</span>
                  )}{" "}
                  <span className="font-mono">({location})</span>
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground" data-testid="column-proposal-reason">
                {p.reason}
              </p>
              {variant === "optional" && p.suggestedDdl ? (
                <pre
                  className="mt-1 overflow-x-auto rounded bg-muted/40 px-2 py-1 font-mono text-xs"
                  data-testid="column-proposal-ddl"
                >
                  {p.suggestedDdl}
                </pre>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
