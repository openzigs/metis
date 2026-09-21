/**
 * Phase 12 — Library page.
 *
 * Now hosts three sections behind tabs:
 *   1. Browse  — original Phase 10 search across skills + agents (unchanged
 *                semantics; per-project allow-list toggles still work).
 *   2. Templates — Phase 12 prompt templates with `{{var}}` substitution
 *                  and a "Run" hand-off into the workbench/chat (#85).
 *   3. Artifacts — Phase 12 browseable analyses + downloadable JSON exports.
 */
"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { TemplatesSection } from "@/components/library/templates-section";
import { ArtifactsSection } from "@/components/library/artifacts-section";
import { LibraryBrowseSection } from "@/components/library/browse-section";
import { ConnectorsSection } from "@/components/library/connectors-section";

type Tab = "browse" | "templates" | "artifacts" | "connectors";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "browse", label: "Browse" },
  { id: "templates", label: "Templates" },
  { id: "artifacts", label: "Artifacts" },
  { id: "connectors", label: "Connectors" },
];

export default function LibraryPage() {
  const params = useSearchParams();
  const projectId = params.get("projectId") ?? null;
  const initial = (params.get("tab") as Tab | null) ?? "browse";
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.id === initial) ? initial : "browse");

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="library-root">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
        <p className="text-sm text-muted-foreground">
          Skills, agents, prompt templates, and artifacts.{" "}
          {projectId
            ? "Toggle skills/agents per project; templates and artifacts are scoped to your account."
            : "Open a project to manage per-project access."}
        </p>
      </header>

      <div role="tablist" aria-label="Library sections" className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`library-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={
              "border-b-2 px-3 py-2 text-sm transition-colors " +
              (tab === t.id
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={`${tab} panel`}>
        {tab === "browse" ? (
          <LibraryBrowseSection projectId={projectId} />
        ) : tab === "templates" ? (
          <TemplatesSection />
        ) : tab === "artifacts" ? (
          <ArtifactsSection projectId={projectId} />
        ) : (
          <ConnectorsSection projectId={projectId} />
        )}
      </div>
    </div>
  );
}
