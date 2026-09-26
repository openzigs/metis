"use client";

/**
 * #190 — a generated-document version's heavy artifacts, each fetched from its
 * own endpoint only when the user opens the matching panel. For a
 * full-coverage document the provenance manifest alone is tens of megabytes,
 * so none of this travels with the document detail any more.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

/** Changed symbols shown per page. */
export const CHANGED_SYMBOLS_PAGE = 200;

interface ChangedSymbolsPage {
  total: number;
  offset: number;
  items: string[];
}

/** The subset of the provenance manifest the panel summarises. */
interface ProvenanceManifest {
  revision: { revisionId: string; version: number };
  document: { generatedAt: string };
  generation: {
    pipeline?: string;
    model: { phase1: { model: string }; phase2: { model: string } };
  };
  sourceFingerprints: unknown[];
  selectedEvidence: { primary: unknown[] };
  sections: unknown[];
  historicalCitations: { status: string; mode: string };
}

type Panel = "symbols" | "provenance" | null;

export function VersionArtifacts({
  projectId,
  docId,
  versionId,
  version,
}: {
  projectId: string;
  docId: string;
  versionId: string;
  version: number;
}): React.ReactElement {
  const [open, setOpen] = useState<Panel>(null);
  const base = `/projects/${projectId}/docs/${docId}/versions/${versionId}`;

  // Versions are immutable, so neither artifact ever goes stale.
  const symbols = useQuery<ChangedSymbolsPage>({
    queryKey: ["generated-docs", projectId, docId, "version", versionId, "changed-symbols"],
    queryFn: () =>
      apiFetch<ChangedSymbolsPage>(`${base}/changed-symbols?limit=${CHANGED_SYMBOLS_PAGE}`),
    enabled: open === "symbols",
    staleTime: Infinity,
  });
  const provenance = useQuery<ProvenanceManifest>({
    queryKey: ["generated-docs", projectId, docId, "version", versionId, "provenance"],
    queryFn: () => apiFetch<ProvenanceManifest>(`${base}/provenance`),
    enabled: open === "provenance",
    staleTime: Infinity,
  });

  const toggle = (panel: Exclude<Panel, null>) => setOpen((cur) => (cur === panel ? null : panel));

  return (
    <div className="pl-4 text-xs">
      <div className="flex gap-3">
        <button
          type="button"
          className="text-muted-foreground underline hover:text-foreground"
          aria-expanded={open === "symbols"}
          onClick={() => toggle("symbols")}
          data-testid={`version-symbols-toggle-${versionId}`}
        >
          Changed symbols
        </button>
        <button
          type="button"
          className="text-muted-foreground underline hover:text-foreground"
          aria-expanded={open === "provenance"}
          onClick={() => toggle("provenance")}
          data-testid={`version-provenance-toggle-${versionId}`}
        >
          Provenance
        </button>
      </div>

      {open === "symbols" && (
        <div className="mt-1 rounded border p-2" data-testid={`version-symbols-${versionId}`}>
          {symbols.isLoading && <p role="status">Loading changed symbols…</p>}
          {symbols.isError && <p role="alert">Could not load the changed symbols.</p>}
          {symbols.data && (
            <>
              <p className="mb-1 font-medium">
                {symbols.data.total === 0
                  ? `v${version} lists no changed symbols.`
                  : `${symbols.data.total.toLocaleString()} changed symbol${
                      symbols.data.total === 1 ? "" : "s"
                    } in v${version}`}
              </p>
              {symbols.data.items.length > 0 && (
                <ul className="max-h-48 overflow-y-auto font-mono">
                  {symbols.data.items.map((name, i) => (
                    <li key={`${i}:${name}`} className="truncate" title={name}>
                      {name}
                    </li>
                  ))}
                </ul>
              )}
              {symbols.data.total > symbols.data.items.length && (
                <p className="mt-1 text-muted-foreground">
                  Showing the first {symbols.data.items.length.toLocaleString()}.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {open === "provenance" && (
        <div className="mt-1 rounded border p-2" data-testid={`version-provenance-${versionId}`}>
          {provenance.isLoading && <p role="status">Loading provenance…</p>}
          {provenance.isError && <p role="alert">Could not load the provenance manifest.</p>}
          {provenance.data && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-muted-foreground">Revision</dt>
              <dd className="font-mono">{provenance.data.revision.revisionId}</dd>
              <dt className="text-muted-foreground">Generated</dt>
              <dd>{new Date(provenance.data.document.generatedAt).toLocaleString()}</dd>
              <dt className="text-muted-foreground">Pipeline</dt>
              <dd>{provenance.data.generation.pipeline ?? "unknown"}</dd>
              <dt className="text-muted-foreground">Models</dt>
              <dd>
                {provenance.data.generation.model.phase1.model} /{" "}
                {provenance.data.generation.model.phase2.model}
              </dd>
              <dt className="text-muted-foreground">Sections</dt>
              <dd>{provenance.data.sections.length.toLocaleString()}</dd>
              <dt className="text-muted-foreground">Evidence</dt>
              <dd>
                {provenance.data.selectedEvidence.primary.length.toLocaleString()} selected from{" "}
                {provenance.data.sourceFingerprints.length.toLocaleString()} sources
              </dd>
              <dt className="text-muted-foreground">Citations</dt>
              <dd>
                {provenance.data.historicalCitations.status} (
                {provenance.data.historicalCitations.mode})
              </dd>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
