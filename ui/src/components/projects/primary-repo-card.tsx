"use client";

/**
 * PrimaryRepoCard — Epic #640 / sub-issue #643.
 *
 * Displays the primary repository for a project on the Settings tab.
 * Shows repo info when set, or a prompt to add one when unset.
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function PrimaryRepoCard({ projectId }: { projectId: string }) {
  const primary = useQuery({
    queryKey: ["connectors", "repos", projectId, "primary"],
    queryFn: () => repoConnectorsApi.getPrimary(projectId),
    enabled: Boolean(projectId),
  });

  return (
    <Card className="space-y-2 p-4" data-testid="primary-repo-card">
      <h3 className="text-sm font-semibold">Primary Repository</h3>
      {primary.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : primary.data ? (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {primary.data.ownerOrOrg}/{primary.data.repoName}
            </p>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                {primary.data.provider === "github_enterprise" ? "GitHub Enterprise" : "GitHub"}
              </Badge>
              <Badge
                variant={primary.data.status === "connected" ? "default" : "outline"}
                className="text-xs"
              >
                {primary.data.status}
              </Badge>
              {primary.data.apiBaseUrl && (
                <span className="text-xs text-muted-foreground">{primary.data.apiBaseUrl}</span>
              )}
            </div>
          </div>
          <Link href={`/projects/${projectId}/connections`}>
            <Button variant="outline" size="sm">
              Change
            </Button>
          </Link>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">No primary repository linked.</p>
          <Link href={`/projects/${projectId}/connections`}>
            <Button variant="outline" size="sm">
              Add one in Connections
            </Button>
          </Link>
        </div>
      )}
    </Card>
  );
}
