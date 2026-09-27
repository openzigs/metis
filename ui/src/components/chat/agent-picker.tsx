"use client";

/**
 * Phase 10 — chat-time agent picker (issue #76 AC).
 *
 * Lets the user pick an agent persona before/within a chat session.
 * Last selection is persisted in `localStorage` per the AC ("Switching
 * agents starts a new session"). Switching is a controlled change — the
 * parent re-creates the session.
 *
 * #236 — ONE picker for both kinds of agent: the library agents, and — in a
 * one-project session — the custom agents that project owns or has enabled
 * (the server's `GET /api/ai/session-agents` applies the same rule session
 * creation enforces). A library agent's value is its KEY, so a choice stored
 * before #236 still selects it; a custom agent's value is its `custom:<id>` ref.
 * Agents are still MANAGED on their own pages (#31); this only picks one.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { listSessionAgents } from "@/lib/ai-client";
import { queryKeys } from "@/lib/query-keys";

const STORAGE_KEY = "metis.chat.agentKey";

export function loadStoredAgentKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeAgentKey(value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow — Safari private mode etc. */
  }
}

interface Props {
  value: string | null;
  onChange: (key: string | null) => void;
  disabled?: boolean;
  /** The session's one project, when it has one: its custom agents are listed too. */
  projectId?: string | null;
}

export function AgentPicker({ value, onChange, disabled, projectId }: Props) {
  const list = useQuery({
    queryKey: queryKeys.agents.list({ pickerOnly: true, projectId: projectId ?? null }),
    queryFn: () => listSessionAgents(projectId),
  });

  useEffect(() => {
    if (value) storeAgentKey(value);
  }, [value]);

  const items = list.data ?? [];
  const library = items.filter((a) => a.kind === "library");
  const custom = items.filter((a) => a.kind === "custom");

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Agent:</span>
      <select
        aria-label="Agent"
        data-testid="agent-picker"
        className="rounded border bg-background px-2 py-1 text-sm disabled:opacity-50"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled || list.isLoading}
      >
        <option value="">Default</option>
        {library.length > 0 ? (
          <optgroup label="Library agents">
            {library.map((a) => (
              <option key={a.ref} value={a.key}>
                {a.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {custom.length > 0 ? (
          <optgroup label="Project agents">
            {custom.map((a) => (
              <option key={a.ref} value={a.ref}>
                {a.name}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}
