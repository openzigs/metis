"use client";

/**
 * Issue #2341 (epic #2328) — the change request's name and what it was started
 * from, at the top of its page: the title (renamed in place by a user who can
 * start a run), the documents and imported items it was started from, and the
 * settings it ran with, saying so when they were the defaults.
 *
 * #2437 — and how many restricted files the run left out, and why.
 *
 * #2548 — when the viewer cannot see all of it, one line at the top says why
 * results read "Restricted", and the settings say web research was skipped when
 * the run withheld it for reading restricted material.
 *
 * Every string here is rendered as React text, never as HTML or Markdown: a
 * title or a document name holding markup shows the markup as typed.
 */
import { useState } from "react";
import {
  CHANGE_REQUEST_TITLE_MAX,
  RESTRICTED_READ_WEB_RESEARCH_NOTICE,
  RESTRICTED_RUN_NOTICE,
  normaliseChangeRequestTitle,
} from "@metis/shared";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import { analysisApi, type AnalysisSnapshot } from "@/lib/analysis-api";
import { queryKeys } from "@/lib/query-keys";
import { useAppMutation } from "@/lib/use-app-mutation";
import { RestrictedLeftOutNotice } from "./restricted-left-out-notice";

/**
 * #2548 — web research was asked for and not run, because the run read
 * restricted material (#2506): the flag every viewer is sent, or the notice a
 * viewer who sees the whole run reads in `webResearch` (a run from before the flag).
 */
function webResearchWithheld(metadata: Record<string, unknown> | null | undefined): boolean {
  if (metadata?.webResearchWithheld === true) return true;
  const research = metadata?.webResearch as { notice?: unknown } | null | undefined;
  return research?.notice === RESTRICTED_READ_WEB_RESEARCH_NOTICE;
}

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
  const webResearch =
    enhancement.enableWebResearch !== true
      ? "off"
      : webResearchWithheld(metadata)
        ? "skipped (restricted material)"
        : "on";
  const lines = [
    keys.length > 0 ? `Agents: ${keys.map(agentName).join(", ")}` : null,
    `Model: ${model ?? "chosen automatically"}`,
    `Clarifying questions: ${enhancement.enableClarification === true ? "on" : "off"}`,
    `Web research: ${webResearch}`,
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
      {snapshot.restrictedView ? (
        // #2548 — said once, here, rather than only on each "Restricted" row.
        <p
          className="rounded border border-dashed border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground"
          role="note"
          data-testid="change-request-restricted-notice"
        >
          {RESTRICTED_RUN_NOTICE}
        </p>
      ) : null}
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
              {/* #2548 — a run reads documents with its starter's access (#2506). */}
              {sources.allDocuments
                ? "all of the project's documents its starter could read"
                : "nothing recorded"}
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
