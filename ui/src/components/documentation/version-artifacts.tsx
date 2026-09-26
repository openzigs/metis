"use client";

/**
 * #190 — a generated-document version's heavy artifacts, each fetched from its
 * own endpoint only when the user opens the matching panel. For a
 * full-coverage document the provenance manifest alone is tens of megabytes,
 * so none of this travels with the document detail any more.
 *
 * #196 — the Provenance panel shows a server-computed summary; the full
 * manifest is fetched only when the user asks to download it.
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

/** `GET …/provenance/summary` — the fields the panel shows (#196). */
interface ProvenanceSummary {
  revisionId: string;
  version: number;
  generatedAt: string;
  pipeline: string;
  models: { phase1: string; phase2: string };
  sectionCount: number;
  selectedEvidenceCount: number;
  sourceCount: number;
  historicalCitations: { status: string; mode: string };
}

/** Save the full manifest as a JSON file. Fetched only on this explicit request. */
async function downloadManifest(base: string, filename: string): Promise<void> {
  const manifest = await apiFetch<unknown>(`${base}/provenance`);
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
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
  const provenance = useQuery<ProvenanceSummary>({
    queryKey: ["generated-docs", projectId, docId, "version", versionId, "provenance-summary"],
    queryFn: () => apiFetch<ProvenanceSummary>(`${base}/provenance/summary`),
    enabled: open === "provenance",
    staleTime: Infinity,
  });
  const [download, setDownload] = useState<"idle" | "busy" | "failed">("idle");
  const onDownload = () => {
    setDownload("busy");
    downloadManifest(base, `provenance-v${version}.json`).then(
      () => setDownload("idle"),
      () => setDownload("failed"),
    );
  };

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
            <>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                <dt className="text-muted-foreground">Revision</dt>
                <dd className="font-mono">{provenance.data.revisionId}</dd>
                <dt className="text-muted-foreground">Generated</dt>
                <dd>{new Date(provenance.data.generatedAt).toLocaleString()}</dd>
                <dt className="text-muted-foreground">Pipeline</dt>
                <dd>{provenance.data.pipeline}</dd>
                <dt className="text-muted-foreground">Models</dt>
                <dd>
                  {provenance.data.models.phase1} / {provenance.data.models.phase2}
                </dd>
                <dt className="text-muted-foreground">Sections</dt>
                <dd>{provenance.data.sectionCount.toLocaleString()}</dd>
                <dt className="text-muted-foreground">Evidence</dt>
                <dd>
                  {provenance.data.selectedEvidenceCount.toLocaleString()} selected from{" "}
                  {provenance.data.sourceCount.toLocaleString()} sources
                </dd>
                <dt className="text-muted-foreground">Citations</dt>
                <dd>
                  {provenance.data.historicalCitations.status} (
                  {provenance.data.historicalCitations.mode})
                </dd>
              </dl>
              <button
                type="button"
                className="mt-1 text-muted-foreground underline hover:text-foreground disabled:opacity-50"
                onClick={onDownload}
                disabled={download === "busy"}
              >
                Download full manifest
              </button>
              {download === "failed" && <p role="alert">Could not download the manifest.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
