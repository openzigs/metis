/**
 * #733 — a warning shown when a publish target is the repository the project's
 * repo connector analyses. For an analysed open-source project that is its
 * upstream, and filing issues there is rarely what the user meant.
 */
import * as React from "react";
import { isAnalysedRepo } from "@/lib/publish-target";

export interface AnalysedRepoWarningProps {
  target: { owner: string; repo: string };
  connector: { ownerOrOrg?: string | null; repoName?: string | null } | null | undefined;
  testId: string;
}

export function AnalysedRepoWarning({
  target,
  connector,
  testId,
}: AnalysedRepoWarningProps): React.ReactElement | null {
  if (!isAnalysedRepo(target, connector)) return null;
  return (
    <p data-testid={testId} role="status" className="mt-2 text-xs text-warning">
      {target.owner}/{target.repo} is the repository this project analyses. Issues will be filed
      there — if it is an upstream you do not own, choose your own repository instead.
    </p>
  );
}
