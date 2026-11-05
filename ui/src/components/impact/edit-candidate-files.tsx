/**
 * EditCandidateFiles — #1762 (epic #1751).
 *
 * The files to edit, each with WHY it was chosen, when the server recorded how
 * the change was seeded (`ImpactItemView.seedEvidence`, written only when a
 * seed lever beyond the default search ran):
 *
 *   - "Found by": the channels that named the file, in business wording;
 *   - "Why" and "Code": the AI check's one-line reason and the line it named,
 *     linked to the code, shown ONLY for a verified promotion (the server
 *     checks the line against the code graph; an unverified reason is never
 *     shown as fact);
 *   - "Doubtful": a badge with the AI check's doubt. The file stays listed.
 *
 * Files are listed in the server's edit order (`seedEvidence.editCandidates`),
 * so a re-ordered list (#1798) or the code agent's citations (#1759) read the
 * way they were ranked. When nothing confident is left, the panel says plainly
 * that METIS could not find the code, instead of padding the list.
 *
 * A run without `seedEvidence` never reaches this component: the group renders
 * exactly as before.
 */
"use client";

import type {
  ImpactAffectedSymbolView,
  ImpactEditVerdict,
  ImpactSeedChannel,
  ImpactSeedEvidence,
} from "@metis/shared";
import { Badge } from "@/components/ui/badge";
import { buildCodeCitationBlobUrl, type CodeCitationRepo } from "@/lib/code-citation-blob-url";
import { AffectedSymbolRow } from "./affected-symbol-row";

/** Business wording for each seed channel. A new channel must be named here (typecheck). */
export const SEED_CHANNEL_LABEL: Record<ImpactSeedChannel, string> = {
  hybrid: "Keyword and meaning search",
  "stored-link": "Linked to this requirement",
  "edit-verifier": "AI edit check",
  "edit-reranker": "AI ranking",
  "code-agent": "Code agent",
};

/** An edit file the engine added after seeding, named by what put it there. */
const RELATION_FOUND_BY: Partial<Record<ImpactAffectedSymbolView["relation"], string>> = {
  "data-writer": "Data lineage",
  "data-model": "Table definition",
};

export interface EditFileRow {
  filePath: string;
  symbols: ImpactAffectedSymbolView[];
  /** Business-worded sources, in channel order; empty when unknown. */
  foundBy: string[];
  verdict?: ImpactEditVerdict;
}

/**
 * The edit files in the server's edit order, each with its sources and verdict.
 * A file the evidence does not list (a lineage writer or table definition the
 * engine added after seeding) follows, in the order given.
 */
export function orderEditFiles(
  groups: ReadonlyArray<{ filePath: string; symbols: ImpactAffectedSymbolView[] }>,
  evidence: ImpactSeedEvidence,
): EditFileRow[] {
  const entries = new Map(evidence.editCandidates.map((e, i) => [e.filePath, { e, i }]));
  const rank = (filePath: string) => entries.get(filePath)?.i ?? Number.POSITIVE_INFINITY;
  return groups
    .map((g, order) => ({ g, order }))
    .sort((a, b) => rank(a.g.filePath) - rank(b.g.filePath) || a.order - b.order)
    .map(({ g }) => {
      const entry = entries.get(g.filePath)?.e;
      const foundBy = entry
        ? [...new Set(entry.channels.map((c) => SEED_CHANNEL_LABEL[c]))]
        : [
            ...new Set(
              g.symbols.flatMap((s) => {
                const label = RELATION_FOUND_BY[s.relation];
                return label ? [label] : [];
              }),
            ),
          ];
      return {
        filePath: g.filePath,
        symbols: g.symbols,
        foundBy,
        ...(entry?.verdict ? { verdict: entry.verdict } : {}),
      };
    });
}

/** True for a file the AI check doubts: still listed, never counted as confident. */
export function isDoubtful(row: EditFileRow): boolean {
  return row.verdict?.kind === "doubtful";
}

/** The last path segment, for a short "file:line" label. */
function fileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function EditFile({ row, repo }: { row: EditFileRow; repo: CodeCitationRepo | null }) {
  const verdict = row.verdict;
  // Only a promotion the server checked against the code graph carries a reason shown as fact.
  const verified = verdict?.kind === "promoted" && verdict.verified === true ? verdict : null;
  const doubt = verdict?.kind === "doubtful" ? verdict : null;
  const codeHref = verified
    ? buildCodeCitationBlobUrl(repo, {
        filePath: row.filePath,
        startLine: verified.line,
        endLine: verified.line,
      })
    : null;
  const codeLabel = verified ? `${fileName(row.filePath)}:${verified.line}` : "";

  return (
    <div data-testid="edit-candidate-file-group" data-doubtful={doubt ? "true" : undefined}>
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <p className="truncate font-mono text-xs text-foreground">{row.filePath}</p>
        {doubt ? (
          <Badge
            variant="outline"
            className="shrink-0 border-warning/60 text-warning"
            data-testid="edit-candidate-doubtful"
          >
            Doubtful
          </Badge>
        ) : null}
      </div>
      <dl className="mb-1 space-y-0.5 text-xs text-muted-foreground">
        {row.foundBy.length > 0 ? (
          <div className="flex gap-1" data-testid="edit-candidate-found-by">
            <dt className="font-medium">Found by:</dt>
            <dd>{row.foundBy.join(", ")}</dd>
          </div>
        ) : null}
        {verified ? (
          <>
            <div className="flex gap-1" data-testid="edit-candidate-why">
              <dt className="font-medium">Why:</dt>
              <dd>{verified.reason}</dd>
            </div>
            <div className="flex gap-1" data-testid="edit-candidate-code">
              <dt className="font-medium">Code:</dt>
              <dd className="font-mono">
                {codeHref ? (
                  <a
                    href={codeHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline-offset-2 hover:underline"
                    title={`Open ${row.filePath}:${verified.line}`}
                    data-testid="edit-candidate-code-link"
                  >
                    {codeLabel}
                  </a>
                ) : (
                  codeLabel
                )}
              </dd>
            </div>
          </>
        ) : null}
        {doubt ? (
          <div className="flex gap-1" data-testid="edit-candidate-doubt">
            <dt className="font-medium">The AI check doubts it:</dt>
            <dd>{doubt.reason}</dd>
          </div>
        ) : null}
      </dl>
      <ul className="space-y-1">
        {row.symbols.map((s) => (
          <AffectedSymbolRow key={s.id} symbol={s} repo={repo} />
        ))}
      </ul>
    </div>
  );
}

export interface EditCandidateFilesProps {
  rows: EditFileRow[];
  repo: CodeCitationRepo | null;
  /** The project searched, named in the "not found" message. */
  projectLabel: string;
}

export function EditCandidateFiles({ rows, repo, projectLabel }: EditCandidateFilesProps) {
  const confident = rows.filter((r) => !isDoubtful(r));
  const doubtful = rows.filter(isDoubtful);

  if (confident.length === 0) {
    return (
      <div className="space-y-2" data-testid="edit-candidates">
        <p
          className="rounded border border-border/60 bg-muted/40 px-3 py-2 text-sm text-foreground"
          data-testid="edit-candidates-not-found"
          role="status"
        >
          METIS could not find the code this change touches in{" "}
          <span className="font-medium">{projectLabel}</span>.
          {doubtful.length > 0
            ? " The files below were considered, but the AI check doubts them."
            : null}
        </p>
        {doubtful.length > 0 ? (
          <div className="space-y-3">
            {doubtful.map((row) => (
              <EditFile key={row.filePath} row={row} repo={repo} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="edit-candidates">
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        Files to edit — the code this change most likely has to touch, most likely first
      </p>
      <div className="space-y-3">
        {rows.map((row) => (
          <EditFile key={row.filePath} row={row} repo={repo} />
        ))}
      </div>
    </div>
  );
}
