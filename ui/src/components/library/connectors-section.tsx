"use client";

/**
 * Library → Connectors tab (Epic #163, Issue #96).
 *
 * Provides "Add from Confluence" and "Add from Jira" buttons that open a
 * modal letting the user pick a Confluence space (with optional CQL query)
 * or a Jira JQL filter. Credentials NEVER reach the browser — the server
 * resolves them from the project's MCP config (mcp-atlassian) at ingest
 * time.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import { atlassianApi, type AtlassianIngestSummary } from "@/lib/enterprise-api";

type Mode = "confluence" | "jira" | null;

interface LastRun {
  source: "confluence" | "jira";
  summary: AtlassianIngestSummary;
}

/**
 * #2244 — what a run left out, in the analyst's words, or null when it took
 * everything the search matched.
 */
export function omittedMessage({ source, summary }: LastRun): string | null {
  if (!(summary.omitted > 0)) return null;
  const noun = source === "confluence" ? "pages" : "issues";
  const processed = summary.found - summary.omitted;
  const why =
    processed >= summary.limit
      ? `One run ingests at most ${summary.limit} ${noun}.`
      : `The search returned only ${processed}.`;
  return `${summary.omitted} of ${summary.found} matching ${noun} were not ingested. ${why} Narrow the query and run it again to bring in the rest.`;
}

export interface ConnectorsSectionProps {
  projectId: string | null;
}

export function ConnectorsSection({ projectId }: ConnectorsSectionProps) {
  const [mode, setMode] = useState<Mode>(null);
  const [spaceKey, setSpaceKey] = useState("");
  const [query, setQuery] = useState("");
  const [jql, setJql] = useState("");
  const [lastRun, setLastRun] = useState<LastRun | null>(null);

  const status = useQuery({
    queryKey: ["atlassian-status", projectId],
    queryFn: () => atlassianApi.status(projectId!),
    enabled: Boolean(projectId),
  });

  const ingest = useMutation({
    mutationFn: async (): Promise<LastRun> => {
      if (!projectId) throw new Error("project required");
      if (mode === "confluence") {
        const summary = await atlassianApi.ingestConfluence(projectId, {
          spaceKey,
          query: query.trim() || undefined,
        });
        return { source: "confluence", summary };
      }
      return { source: "jira", summary: await atlassianApi.ingestJira(projectId, { jql }) };
    },
    onSuccess: (data) => {
      setLastRun(data);
      setMode(null);
      setSpaceKey("");
      setQuery("");
      setJql("");
    },
  });

  if (!projectId) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="connectors-no-project">
        Open a project to ingest from Confluence or Jira.
      </p>
    );
  }

  const configured = status.data?.configured === true;
  const omitted = lastRun ? omittedMessage(lastRun) : null;
  const canSubmit =
    mode === "confluence"
      ? spaceKey.trim().length > 0
      : mode === "jira"
        ? jql.trim().length > 0
        : false;

  return (
    <div className="space-y-4" data-testid="connectors-section">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Atlassian Connectors</h2>
            <p className="text-xs text-muted-foreground" data-testid="connectors-status">
              {status.isLoading
                ? "Checking project MCP configuration…"
                : configured
                  ? "mcp-atlassian server detected. Credentials stay on the server."
                  : "No mcp-atlassian server configured for this project."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="add-from-confluence"
              disabled={!configured}
              onClick={() => setMode("confluence")}
            >
              Add from Confluence
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="add-from-jira"
              disabled={!configured}
              onClick={() => setMode("jira")}
            >
              Add from Jira
            </Button>
          </div>
        </div>
        {lastRun && (
          <p className="mt-3 text-xs text-success" data-testid="connectors-last-summary">
            Ingested {lastRun.summary.documentsCreated} new · updated{" "}
            {lastRun.summary.documentsUpdated} · unchanged {lastRun.summary.skipped} · failed{" "}
            {lastRun.summary.failures}
          </p>
        )}
        {/* #2260 — the live region is always mounted, so a screen reader announces the
            note when it arrives; a region that mounts with its text is not reliably read. */}
        <div role="status" data-testid="connectors-last-omitted-region">
          {omitted && (
            <p className="mt-1 text-xs text-warning" data-testid="connectors-last-omitted">
              {omitted}
            </p>
          )}
        </div>
      </Card>

      {/* #268 — Radix Dialog: focus trap, Escape, focus return. */}
      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMode(null);
            ingest.reset();
          }
        }}
      >
        <DialogContent
          className="max-w-md"
          data-testid="connector-modal"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">
              {mode === "confluence" ? "Ingest a Confluence space" : "Ingest a Jira query"}
            </DialogTitle>
          </DialogHeader>
          {mode === "confluence" ? (
            <div className="space-y-3">
              <div>
                <Label htmlFor="space-key">Space key</Label>
                <Input
                  id="space-key"
                  data-testid="confluence-space-key"
                  value={spaceKey}
                  onChange={(e) => setSpaceKey(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="cql-query">CQL query (optional)</Label>
                <Input
                  id="cql-query"
                  data-testid="confluence-query"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div>
              <Label htmlFor="jql">JQL</Label>
              <Input
                id="jql"
                data-testid="jira-jql"
                value={jql}
                onChange={(e) => setJql(e.target.value)}
                placeholder='project = "ENG" AND status = "Done"'
              />
            </div>
          )}
          {ingest.error && (
            <p className="text-xs text-destructive" data-testid="connector-error">
              {ingest.error instanceof ApiError ? ingest.error.message : String(ingest.error)}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="connector-cancel"
              onClick={() => {
                setMode(null);
                ingest.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!canSubmit || ingest.isPending}
              data-testid="connector-submit"
              onClick={() => ingest.mutate()}
            >
              {ingest.isPending ? "Ingesting…" : "Ingest"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
