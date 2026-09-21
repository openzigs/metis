"use client";

/**
 * Epic #158 (#154) — AGENTS.md card.
 *
 * Surfaces the auto-detected agent set for a project, lets the user copy or
 * download the canonical AGENTS.md file, and shows a live preview pane.
 */
import { useQuery } from "@tanstack/react-query";
import { useTransientToast } from "@/hooks/use-transient-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { agentsMdApi } from "@/lib/runs-api";

interface Props {
  projectId: string;
}

export function AgentsMdCard({ projectId }: Props) {
  // #1284 — the hook owns the 1.5s reset timer AND cancels it on unmount.
  const { toast: copyToast, showToast: showCopyToast } = useTransientToast<"copied" | "failed">(
    1500,
  );
  const copyState = copyToast ?? "idle";

  const md = useQuery({
    queryKey: ["agents-md", projectId, "markdown"],
    queryFn: () => agentsMdApi.getMarkdown(projectId),
    enabled: Boolean(projectId),
  });

  const preview = useQuery({
    queryKey: ["agents-md", projectId, "preview"],
    queryFn: () => agentsMdApi.preview(projectId),
    enabled: Boolean(projectId),
  });

  async function handleCopy() {
    if (!md.data) return;
    try {
      await navigator.clipboard.writeText(md.data);
      showCopyToast("copied");
    } catch {
      showCopyToast("failed");
    }
  }

  function handleDownload() {
    if (!md.data) return;
    const blob = new Blob([md.data], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "AGENTS.md";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="space-y-3 p-4" data-testid="agents-md-card">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">AGENTS.md</h3>
          <p className="text-xs text-muted-foreground">
            Auto-detected agent set for this project. Copy or download to share with agentic IDEs
            and CLIs.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
            disabled={!md.data}
            data-testid="agents-md-copy"
          >
            {copyState === "copied" ? "Copied!" : copyState === "failed" ? "Copy failed" : "Copy"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleDownload}
            disabled={!md.data}
            data-testid="agents-md-download"
          >
            Download
          </Button>
        </div>
      </div>

      {preview.isLoading || md.isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : md.isError || preview.isError ? (
        <div className="text-xs text-red-600">
          Failed to load AGENTS.md:{" "}
          {((md.error ?? preview.error) as Error | null)?.message ?? "unknown error"}
        </div>
      ) : (
        <>
          {preview.data && (
            <ul className="text-xs text-muted-foreground" data-testid="agents-md-summary">
              {preview.data.agents.map((a) => (
                <li key={a.name}>
                  <span className="font-medium text-foreground">{a.name}</span>{" "}
                  <span>· {a.tools.length} tools</span>{" "}
                  <span className="opacity-70">({a.source})</span>
                </li>
              ))}
            </ul>
          )}
          {md.data && (
            <pre
              className="max-h-72 overflow-auto rounded bg-muted/50 p-3 text-xs"
              data-testid="agents-md-preview"
            >
              {md.data}
            </pre>
          )}
        </>
      )}
    </Card>
  );
}
