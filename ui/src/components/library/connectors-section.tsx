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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import { atlassianApi, type AtlassianIngestSummary } from "@/lib/enterprise-api";

type Mode = "confluence" | "jira" | null;

export interface ConnectorsSectionProps {
  projectId: string | null;
}

export function ConnectorsSection({ projectId }: ConnectorsSectionProps) {
  const [mode, setMode] = useState<Mode>(null);
  const [spaceKey, setSpaceKey] = useState("");
  const [query, setQuery] = useState("");
  const [jql, setJql] = useState("");
  const [lastSummary, setLastSummary] = useState<AtlassianIngestSummary | null>(null);

  const status = useQuery({
    queryKey: ["atlassian-status", projectId],
    queryFn: () => atlassianApi.status(projectId!),
    enabled: Boolean(projectId),
  });

  const ingest = useMutation({
    mutationFn: () => {
      if (!projectId) throw new Error("project required");
      if (mode === "confluence") {
        return atlassianApi.ingestConfluence(projectId, {
          spaceKey,
          query: query.trim() || undefined,
        });
      }
      return atlassianApi.ingestJira(projectId, { jql });
    },
    onSuccess: (data) => {
      setLastSummary(data);
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
        {lastSummary && (
          <p className="mt-3 text-xs text-emerald-600" data-testid="connectors-last-summary">
            Ingested {lastSummary.ingested} · skipped {lastSummary.skipped} · failed{" "}
            {lastSummary.failed}
          </p>
        )}
      </Card>

      {mode && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={mode === "confluence" ? "Confluence ingest" : "Jira ingest"}
          data-testid="connector-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <Card className="w-full max-w-md p-4">
            <h3 className="text-sm font-semibold">
              {mode === "confluence" ? "Ingest a Confluence space" : "Ingest a Jira query"}
            </h3>
            {mode === "confluence" ? (
              <div className="mt-3 space-y-3">
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
              <div className="mt-3">
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
              <p className="mt-2 text-xs text-red-600" data-testid="connector-error">
                {ingest.error instanceof ApiError ? ingest.error.message : String(ingest.error)}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
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
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
