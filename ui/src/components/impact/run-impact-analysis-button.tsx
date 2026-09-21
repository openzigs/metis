/**
 * RunImpactAnalysisButton — Epic #159 (#164).
 *
 * Submit control for the create flow. Disabled until the form is valid; shows
 * a pending label while the analysis is being triggered.
 */
"use client";

import { Button } from "@/components/ui/button";

export interface RunImpactAnalysisButtonProps {
  disabled: boolean;
  isPending: boolean;
  onClick: () => void;
}

export function RunImpactAnalysisButton({
  disabled,
  isPending,
  onClick,
}: RunImpactAnalysisButtonProps) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled || isPending}
      data-testid="run-impact-analysis"
    >
      {isPending ? "Starting…" : "Run impact analysis"}
    </Button>
  );
}
