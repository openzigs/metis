"use client";

/**
 * Phase 10 — chat-time agent picker (issue #76 AC).
 *
 * Lets the user pick an agent persona before/within a chat session.
 * Last selection is persisted in `localStorage` per the AC ("Switching
 * agents starts a new session"). Switching is a controlled change — the
 * parent re-creates the session.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/lib/library-api";
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
}

export function AgentPicker({ value, onChange, disabled }: Props) {
  const list = useQuery({
    queryKey: queryKeys.agents.list({ pickerOnly: true }),
    queryFn: () => agentsApi.list(),
  });

  useEffect(() => {
    if (value) storeAgentKey(value);
  }, [value]);

  const items = (list.data?.items ?? []).filter((a) => a.enabled && !a.archived);

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
        {items.map((a) => (
          <option key={a.id} value={a.key}>
            {a.displayName || a.name}
          </option>
        ))}
      </select>
    </label>
  );
}
