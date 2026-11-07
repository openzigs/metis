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

import {
  impactFileKey,
  type ImpactAffectedSymbolView,
  type ImpactEditVerdict,
  type ImpactSeedChannel,
  type ImpactSeedEvidence,
  type ImpactSymbolRepoRef,
} from "@metis/shared";
import { Badge } from "@/components/ui/badge";
import { buildCodeCitationBlobUrl, type CodeCitationRepo } from "@/lib/code-citation-blob-url";
import { AffectedSymbolRow } from "./affected-symbol-row";
import { ImpactFileLabel } from "./impact-file-label";

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
  /** #1965 — (repository, path): one path in two repositories is two rows. */
  key: string;
  filePath: string;
  repo: ImpactSymbolRepoRef | null;
  symbols: ImpactAffectedSymbolView[];
  /** Business-worded sources, in channel order; empty when unknown. */
  foundBy: string[];
  verdict?: ImpactEditVerdict;
}

/**
 * The edit files in the server's edit order, each with its sources and verdict.
 * A file the evidence does not list (a lineage writer or table definition the
 * engine added after seeding) follows, in the order given.
 *
 * #1969 — an entry that names its file's repository (`repoConnectionId`)
 * speaks for that repository's file only. One that names none (the path was
 * seeded from several repositories, or the evidence predates #1969) speaks for
 * the path in each, as in #1965.
 */
export function orderEditFiles(
  groups: ReadonlyArray<{
    filePath: string;
    repo?: ImpactSymbolRepoRef | null;
    symbols: ImpactAffectedSymbolView[];
  }>,
  evidence: ImpactSeedEvidence,
): EditFileRow[] {
  const entryOf = (g: (typeof groups)[number]) => {
    const i = evidence.editCandidates.findIndex(
      (e) =>
        e.filePath === g.filePath &&
        (e.repoConnectionId === undefined || e.repoConnectionId === g.repo?.id),
    );
    return i < 0 ? undefined : { e: evidence.editCandidates[i]!, i };
  };
  return groups
    .map((g, order) => ({ g, order, found: entryOf(g) }))
    .sort(
      (a, b) =>
        (a.found?.i ?? Number.POSITIVE_INFINITY) - (b.found?.i ?? Number.POSITIVE_INFINITY) ||
        a.order - b.order,
    )
    .map(({ g, found }) => {
      const entry = found?.e;
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
        key: impactFileKey(g),
        filePath: g.filePath,
        repo: g.repo ?? null,
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

function EditFile({
  row,
  repo,
  showRepo,
}: {
  row: EditFileRow;
  repo: CodeCitationRepo | null;
  showRepo: boolean;
}) {
  const verdict = row.verdict;
  // Only a promotion the server checked against the code graph carries a reason shown as fact.
  // `verified === true` repeats the shared schema's `verified: z.literal(true)`
  // (`impactEditVerdictSchema`) on purpose (#1820): the type already says it, but
  // this guard keeps an unchecked reason from reading as fact if the schema is
  // ever loosened or a view arrives without passing through it.
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
        <ImpactFileLabel
          className="truncate font-mono text-xs text-foreground"
          filePath={row.filePath}
          repo={showRepo ? row.repo : null}
        />
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
  /**
   * #1833 — code-agent citations the run set aside because the code they cite
   * changed (`seedEvidence.agentCitations.demotedStaleCitations`, #1832).
   */
  staleSetAside?: number;
  /** #1965 — name each file's repository (the project connects more than one). */
  showRepo?: boolean;
}

/** #1833 — "N stale citations were set aside", only when there were some. */
function StaleSetAside({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="mb-1 text-xs text-muted-foreground" data-testid="edit-candidates-stale-set-aside">
      {count} stale citation{count === 1 ? " was" : "s were"} set aside: the code{" "}
      {count === 1 ? "it points" : "they point"} at changed since the requirement was evaluated.
    </p>
  );
}

export function EditCandidateFiles({
  rows,
  repo,
  projectLabel,
  staleSetAside = 0,
  showRepo = false,
}: EditCandidateFilesProps) {
  const confident = rows.filter((r) => !isDoubtful(r));
  const doubtful = rows.filter(isDoubtful);

  if (confident.length === 0) {
    return (
      <div className="space-y-2" data-testid="edit-candidates">
        <StaleSetAside count={staleSetAside} />
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
              <EditFile key={row.key} row={row} repo={repo} showRepo={showRepo} />
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
      <StaleSetAside count={staleSetAside} />
      <div className="space-y-3">
        {rows.map((row) => (
          <EditFile key={row.key} row={row} repo={repo} showRepo={showRepo} />
        ))}
      </div>
    </div>
  );
}
