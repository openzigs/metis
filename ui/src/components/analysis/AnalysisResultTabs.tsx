"use client";

/**
 * Issue #30 — a run's results as tabs (Radix Tabs, #268) with a count on each.
 *
 * Only the active tab's content is mounted, which is what keeps the page a few
 * screens tall instead of 113,000 px. The page owns the value (it lives in
 * `?tab=`), so every sub-view is deep-linkable.
 *
 * In-page anchors that predate the tabs — "Go to approvals", "Review
 * questions" — now point at content that may not be mounted. A click on one is
 * intercepted here and turned into a tab switch instead of a dead scroll.
 */
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ANALYSIS_TABS,
  tabCountLabel,
  tabForAnchor,
  type AnalysisTab,
} from "@/components/analysis/analysis-views";

export function AnalysisResultTabs({
  value,
  onValueChange,
  counts,
  children,
}: {
  value: AnalysisTab;
  onValueChange: (tab: AnalysisTab) => void;
  counts: Partial<Record<AnalysisTab, number>>;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      onClickCapture={(e) => {
        const anchor = (e.target as HTMLElement).closest?.("a");
        const tab = tabForAnchor(anchor?.getAttribute("href"));
        // Already on that tab: let the browser scroll to the anchor as before.
        if (tab === null || tab === value) return;
        e.preventDefault();
        onValueChange(tab);
      }}
    >
      <Tabs value={value} onValueChange={(v) => onValueChange(v as AnalysisTab)}>
        <TabsList
          aria-label="Analysis results"
          className="h-auto flex-wrap justify-start"
          data-testid="analysis-result-tabs"
        >
          {ANALYSIS_TABS.map((tab) => {
            const count = counts[tab.value];
            return (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                data-testid={`analysis-tab-${tab.value}`}
              >
                {tab.label}
                {count !== undefined ? (
                  <>
                    <span
                      aria-hidden
                      data-testid={`analysis-tab-count-${tab.value}`}
                      className={`ml-1.5 rounded-full px-1.5 text-[11px] font-semibold ${
                        count > 0 && (tab.value === "questions" || tab.value === "approvals")
                          ? "bg-warning-muted text-warning"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {count}
                    </span>
                    <span className="sr-only"> ({tabCountLabel(tab.value, count)})</span>
                  </>
                ) : null}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {children}
      </Tabs>
    </div>
  );
}
