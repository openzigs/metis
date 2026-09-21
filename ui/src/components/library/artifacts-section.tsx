/**
 * Phase 12 — Library Artifacts section (issue #85: "Artifacts downloadable").
 *
 * Treats completed analyses as the canonical artifact: each row exposes a
 * Download button that materialises the full snapshot (findings +
 * requirements) as a JSON file the analyst can attach to a ticket or
 * email. Project-scoped — without a project we render an empty state so
 * the analyst knows where to focus.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SkeletonText } from "@/components/ui/skeleton";
import { analysisApi } from "@/lib/analysis-api";

interface Props {
  projectId: string | null;
}

export function ArtifactsSection({ projectId }: Props) {
  const list = useQuery({
    queryKey: ["library", "artifacts", projectId ?? "_none"],
    queryFn: () => analysisApi.listForProject(projectId ?? ""),
    enabled: Boolean(projectId),
  });

  if (!projectId) {
    return (
      <Card
        className="border-dashed p-6 text-sm text-muted-foreground"
        data-testid="artifacts-empty"
      >
        <p className="font-medium text-foreground">No project selected</p>
        <p>
          Open a project (or pass <code>?projectId=…</code>) to browse its analysis artifacts.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="artifacts-root">
      {list.isLoading ? (
        <SkeletonText lines={3} />
      ) : (list.data?.items ?? []).length === 0 ? (
        <Card className="border-dashed p-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">No analyses yet</p>
          <p>Run an analysis on this project — completed runs become artifacts here.</p>
        </Card>
      ) : (
        <ul className="grid gap-3" data-testid="artifacts-list">
          {(list.data?.items ?? []).map((a) => (
            <li key={a.id}>
              <Card className="flex items-center justify-between gap-3 p-4">
                <div>
                  <p className="text-sm font-medium">
                    Analysis {a.id.slice(0, 8)}…
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">{a.status}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Started {new Date(a.startedAt).toLocaleString()}
                    {a.completedAt
                      ? ` · Completed ${new Date(a.completedAt).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`artifact-download-${a.id}`}
                  disabled={a.status !== "completed"}
                  onClick={() => downloadArtifact(a.id)}
                >
                  Download
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function downloadArtifact(analysisId: string) {
  const snapshot = await analysisApi.get(analysisId);
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `analysis-${analysisId}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Exported for tests so they can stub the network call without exercising
// the DOM download flow end-to-end.
export const _downloadArtifactForTests = downloadArtifact;
