"use client";

/**
 * Issue #2350 — chat's developer controls (the agent picker, the provider ·
 * model line and the Session skills panel) sit behind an "Advanced" toggle for
 * an analyst. It is off by default and remembered per user, in this browser.
 * An admin sees the controls as before, with no toggle.
 *
 * Hiding is not authorization: the server applies the same rules to a session
 * whatever the page shows. With the toggle off, a new chat starts on the
 * project's configured defaults (the default agent, the project's model).
 */
import { useCallback, useEffect, useState } from "react";
import { useOptionalAuth } from "@/lib/auth-context";

const STORAGE_PREFIX = "metis.chat.advanced.";

/** The stored choice for `userId`; off when never set or unreadable. */
export function loadAdvanced(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + userId) === "on";
  } catch {
    return false;
  }
}

export function storeAdvanced(userId: string, on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (on) window.localStorage.setItem(STORAGE_PREFIX + userId, "on");
    else window.localStorage.removeItem(STORAGE_PREFIX + userId);
  } catch {
    /* Safari private mode */
  }
}

export interface ChatAdvanced {
  /** The signed-in user may toggle (a non-admin); an admin has no toggle. */
  toggleable: boolean;
  /** The toggle's state; meaningful only when `toggleable`. */
  advanced: boolean;
  /** Show the agent picker, the provider · model line and the skills panel. */
  showControls: boolean;
  /** False until the stored choice has been read (one tick after mount). */
  hydrated: boolean;
  setAdvanced: (on: boolean) => void;
}

/**
 * The chat's Advanced state for the signed-in user. With no signed-in user
 * (no auth provider, as in a page test) the controls show as they did before
 * #2350: there is no one to remember a choice for.
 */
export function useChatAdvanced(): ChatAdvanced {
  const auth = useOptionalAuth();
  const user = auth?.user ?? null;
  const userId = user?.id ?? null;
  const toggleable = user !== null && user.role !== "admin";
  const [advanced, setAdvancedState] = useState(false);
  const [hydratedFor, setHydratedFor] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setAdvancedState(toggleable && userId ? loadAdvanced(userId) : false);
    setHydratedFor(userId);
  }, [toggleable, userId]);

  const setAdvanced = useCallback(
    (on: boolean) => {
      if (!toggleable || !userId) return;
      storeAdvanced(userId, on);
      setAdvancedState(on);
    },
    [toggleable, userId],
  );

  return {
    toggleable,
    advanced,
    showControls: !toggleable || advanced,
    hydrated: hydratedFor === userId,
    setAdvanced,
  };
}

interface ToggleProps {
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}

/** The "Advanced" switch in the chat header. */
export function AdvancedToggle({ checked, onChange, disabled }: ToggleProps) {
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        className="h-4 w-4"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="chat-advanced-toggle"
      />
      Advanced
    </label>
  );
}

/**
 * Which assistant answers, in plain words, for a chat whose controls are
 * hidden: the default agent on the project's own settings, unless the chat was
 * started with another agent (a resumed chat keeps the agent it began with).
 */
export function assistantInPlainWords(
  session: { agentId?: string | null; agentRef?: string | null; projectId?: string | null } | null,
  projectScoped: boolean,
): string {
  if (session && (session.agentId || session.agentRef)) {
    return "Answering: the assistant this chat was started with.";
  }
  const scoped = session ? Boolean(session.projectId) : projectScoped;
  return scoped
    ? "Answering: the METIS assistant, with this project’s settings."
    : "Answering: the METIS assistant, with the standard settings.";
}
