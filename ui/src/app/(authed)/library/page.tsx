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
import { LibraryProjectPicker } from "@/components/library/project-picker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
        <TabsContent value="browse">
          <LibraryBrowseSection projectId={projectId} />
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
