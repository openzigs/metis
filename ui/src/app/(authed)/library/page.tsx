/**
 * Phase 12 — Library page.
 *
 * #31 — the one home for skills and for agents. Their tabs carry a scope
 * filter (the project picker): the workspace library, where skills and agents
 * are authored and versioned (was Admin → Skills / Agents), or one project,
 * where its allow-list and its own custom agents are managed (was the Browse
 * tab and project Settings → Custom agents). `?tab=browse` still lands on Skills.
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
import { SkillsLibraryPanel } from "@/components/library/skills-library-panel";
import { AgentsLibraryPanel } from "@/components/library/agents-library-panel";
import { CustomAgentsEnablementCard } from "@/components/projects/custom-agents-enablement-card";
import { ConnectorsSection } from "@/components/library/connectors-section";
import { LibraryProjectPicker } from "@/components/library/project-picker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";

type Tab = "skills" | "agents" | "templates" | "artifacts" | "connectors";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "skills", label: "Skills" },
  { id: "agents", label: "Agents" },
  { id: "templates", label: "Templates" },
  { id: "artifacts", label: "Artifacts" },
  { id: "connectors", label: "Connectors" },
];

export default function LibraryPage() {
  const params = useSearchParams();
  const projectId = params.get("projectId") ?? null;
  const requested = params.get("tab");
  const [tab, setTab] = useState<Tab>(TABS.find((t) => t.id === requested)?.id ?? "skills");

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="library-root">
      <PageHeader
        title="Library"
        description={
          <>
            Skills, agents, prompt templates, and artifacts.{" "}
            {projectId
              ? "Showing what this project may use; templates and artifacts are scoped to your account."
              : "Showing the workspace library. Pick a project as the scope to manage what it may use."}
          </>
        }
      />

      <LibraryProjectPicker projectId={projectId} />

      {/* #268 — Radix Tabs: arrow keys / Home / End, roving tabindex, aria-controls. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList
          aria-label="Library sections"
          className="flex h-auto w-full justify-start gap-1 rounded-none border-b bg-transparent p-0"
        >
          {TABS.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              data-testid={`library-tab-${t.id}`}
              className="rounded-none border-b-2 border-transparent px-3 py-2 font-normal text-muted-foreground shadow-none hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="skills">
          {projectId ? (
            <LibraryBrowseSection projectId={projectId} kind="skill" />
          ) : (
            <SkillsLibraryPanel />
          )}
        </TabsContent>
        <TabsContent value="agents" className="space-y-6">
          {projectId ? (
            <>
              <CustomAgentsEnablementCard projectId={projectId} />
              <LibraryBrowseSection projectId={projectId} kind="agent" />
            </>
          ) : (
            <AgentsLibraryPanel />
          )}
        </TabsContent>
        <TabsContent value="templates">
          <TemplatesSection />
        </TabsContent>
        <TabsContent value="artifacts">
          <ArtifactsSection projectId={projectId} />
        </TabsContent>
        <TabsContent value="connectors">
          <ConnectorsSection projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
