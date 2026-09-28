"use client";

/**
 * Enhancement Pipeline Status (Epic #597 / Issue #625).
 *
 * Shows the progress of the requirements enhancement pipeline:
 * extraction → web research → clarification → approval → complete.
 */

type EnhancementStep = "extraction" | "web-research" | "clarification" | "approval" | "complete";

interface EnhancementStatusProps {
  currentStep: EnhancementStep;
  stepsCompleted: EnhancementStep[];
  enableWebResearch: boolean;
  enableClarification: boolean;
}

const ALL_STEPS: Array<{ key: EnhancementStep; label: string }> = [
  { key: "extraction", label: "Extract Requirements" },
  { key: "web-research", label: "Web Research" },
  { key: "clarification", label: "Clarification" },
  { key: "approval", label: "Approval" },
  { key: "complete", label: "Complete" },
];

export function EnhancementStatus({
  currentStep,
  stepsCompleted,
  enableWebResearch,
  enableClarification,
}: EnhancementStatusProps): React.ReactElement {
  const visibleSteps = ALL_STEPS.filter((s) => {
    if (s.key === "web-research" && !enableWebResearch) return false;
    if (s.key === "clarification" && !enableClarification) return false;
    return true;
  });

  return (
    <div className="flex items-center gap-1">
      {visibleSteps.map((step, i) => {
        const isCompleted = stepsCompleted.includes(step.key);
        const isCurrent = step.key === currentStep;

        return (
          <div key={step.key} className="flex items-center gap-1">
            <div
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                isCompleted
                  ? "border-success/40 bg-success-muted text-success"
                  : isCurrent
                    ? "border-info/40 bg-info-muted text-info"
                    : "border-border bg-muted/50 text-muted-foreground"
              }`}
            >
              {isCompleted ? "✓" : isCurrent ? "●" : "○"}
              <span>{step.label}</span>
            </div>
            {i < visibleSteps.length - 1 && (
              <div className={`h-px w-4 ${isCompleted ? "bg-success/50" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
