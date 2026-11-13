"use client";

/**
 * Issue #2341 (epic #2328) — the change request's name and what it was started
 * from, at the top of its page: the title (renamed in place by a user who can
 * start a run), the documents and imported items it was started from, and the
 * settings it ran with, saying so when they were the defaults.
 *
 * #2437 — and how many restricted files the run left out, and why.
 *
 * Every string here is rendered as React text, never as HTML or Markdown: a
 * title or a document name holding markup shows the markup as typed.
 */
import { useState } from "react";
import { CHANGE_REQUEST_TITLE_MAX, normaliseChangeRequestTitle } from "@metis/shared";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import { analysisApi, type AnalysisSnapshot } from "@/lib/analysis-api";
import { queryKeys } from "@/lib/query-keys";
import { useAppMutation } from "@/lib/use-app-mutation";
import { RestrictedLeftOutNotice } from "./restricted-left-out-notice";

/** The settings a run used, in words, from its stored metadata. */
export function runSettingsSummary(
  metadata: Record<string, unknown> | null | undefined,
  agentName: (key: string) => string = (k) => k,
): { defaults: boolean; lines: string[] } {
  const keys = Array.isArray(metadata?.agentKeys)
    ? (metadata.agentKeys as unknown[]).filter((k): k is string => typeof k === "string")
    : [];
  const model = typeof metadata?.model === "string" && metadata.model ? metadata.model : null;
  // #2451 — `enhancement` is written only when the enhancement step starts,
  // part-way through the run; until then the flags the run was started with.
  const enhancement = (metadata?.enhancement ?? metadata?.enhancementRequested ?? {}) as {
    enableClarification?: unknown;
    enableWebResearch?: unknown;
  };
  const lines = [
    keys.length > 0 ? `Agents: ${keys.map(agentName).join(", ")}` : null,
    `Model: ${model ?? "chosen automatically"}`,
    `Clarifying questions: ${enhancement.enableClarification === true ? "on" : "off"}`,
    `Web research: ${enhancement.enableWebResearch === true ? "on" : "off"}`,
  ].filter((l): l is string => l !== null);
  return { defaults: metadata?.startedWithDefaults === true, lines };
}

interface Props {
  projectId: string;
  snapshot: AnalysisSnapshot;
  /** Fallback label for a payload without a title (an older server). */
  fallbackTitle: string;
  /** The user may rename (holds `analysis.run`); the server enforces it either way. */
  canRename: boolean;
  agentName?: (key: string) => string;
}

export function ChangeRequestSummary({
  projectId,
  snapshot,
  fallbackTitle,
  canRename,
  agentName,
}: Props) {
  const title = snapshot.title ?? fallbackTitle;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  // A pasted TAB or newline becomes a space, as the server normalises it.
  const trimmed = normaliseChangeRequestTitle(draft);
  const rename = useAppMutation({
    mutationFn: (next: string) => analysisApi.rename(projectId, snapshot.id, next),
    successMessage: "Change request renamed",
    invalidateKeys: [
      queryKeys.analyses.detail(snapshot.id),
      queryKeys.analyses.forProject(projectId),
    ],
    onSuccess: () => setEditing(false),
  });
  const sources = snapshot.sources;
  const settings = runSettingsSummary(snapshot.metadata, agentName);

  return (
    <div className="space-y-2" data-testid="change-request-summary">
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed && trimmed !== title) rename.mutate(trimmed);
            else setEditing(false);
          }}
        >
          <label htmlFor="change-request-rename" className="sr-only">
            Change request title
          </label>
          <Input
            id="change-request-rename"
            data-testid="change-request-rename-input"
            value={draft}
            maxLength={CHANGE_REQUEST_TITLE_MAX}
            onChange={(e) => setDraft(e.target.value)}
            className="max-w-md"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!trimmed || rename.isPending}>
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {rename.error instanceof ApiError ? (
            <p role="alert" className="w-full text-sm text-destructive">
              {rename.error.message}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold break-words" data-testid="change-request-title">
            {title}
          </h2>
          {canRename ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Rename change request"
              data-testid="change-request-rename"
              onClick={() => {
                setDraft(title);
                setEditing(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      )}

      {sources ? (
        <div className="text-xs text-muted-foreground" data-testid="change-request-sources">
          <span className="font-medium text-foreground">Started from: </span>
          {sources.documents.length === 0 && sources.importedItems.length === 0 ? (
            <span>
              {sources.allDocuments ? "all of the project's documents" : "nothing recorded"}
            </span>
          ) : (
            <ul className="inline">
              {sources.documents.map((d, i) => (
                <li key={d.id} className="inline">
                  {i > 0 ? ", " : null}
                  {d.name ?? "a document no longer in the project"}
                </li>
              ))}
              {sources.importedItems.map((item, i) => (
                <li key={item.requirementId} className="inline">
                  {i > 0 || sources.documents.length > 0 ? ", " : null}
                  {item.externalId ? `${item.externalId} ` : null}
                  {item.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground" data-testid="change-request-settings">
        <span className="font-medium text-foreground">
          {settings.defaults ? "Run with defaults: " : "Settings: "}
        </span>
        {settings.lines.join(" · ")}
      </p>
      {/* #2437 — the restricted files the run left out, counted, never named. */}
      <RestrictedLeftOutNotice capability={snapshot.capability} />
    </div>
  );
}
