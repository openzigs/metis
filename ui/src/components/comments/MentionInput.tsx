"use client";

/**
 * Epic #728 / Issue #735 — @mention autocomplete textarea.
 *
 * Wraps a Textarea and detects `@` trigger to show a user search dropdown.
 * Inserts `@username ` on selection.
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface UserHit {
  id: string;
  username: string;
  displayName: string;
}

interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /**
   * Epic #475 (#487) — synthetic mention entries injected ABOVE the user search
   * results (e.g. an `@AI` participant in a discussion thread). They are filtered
   * by the typed prefix like real users, but — unlike user search, which needs a
   * ≥1-char prefix — they also show on a bare `@` so the AI is discoverable
   * without typing. Each entry's `username` is what gets inserted (`@<username>`).
   */
  extraSuggestions?: UserHit[];
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Accessible label for the underlying textarea (defaults to none). */
  ariaLabel?: string;
}

/**
 * Search users by prefix using the /api/users endpoint.
 *
 * `apiFetch` already unwraps the `{ success, data }` envelope, so this returns
 * the `UserHit[]` payload directly — do NOT unwrap a second time (issue #281).
 */
async function searchUsers(prefix: string): Promise<UserHit[]> {
  if (!prefix) return [];
  return (await apiFetch<UserHit[]>(`/users?search=${encodeURIComponent(prefix)}&limit=8`)) ?? [];
}

/**
 * Detect whether the text ends with a `@mention` trigger.
 * Returns the partial username being typed, or null if not in a trigger.
 * Checks the tail of the value so it works regardless of cursor position.
 */
function detectMentionTrigger(value: string): { prefix: string; triggerStart: number } | null {
  const match = /@([A-Za-z0-9_.-]*)$/.exec(value);
  if (!match) return null;
  return {
    prefix: match[1],
    triggerStart: match.index,
  };
}

export function MentionInput({
  value,
  onChange,
  placeholder,
  className,
  disabled,
  extraSuggestions = [],
  onKeyDown: onKeyDownProp,
  ariaLabel,
}: MentionInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [trigger, setTrigger] = useState<{
    prefix: string;
    triggerStart: number;
  } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { data: userHits = [] } = useQuery<UserHit[]>({
    queryKey: ["users", "mention-search", trigger?.prefix ?? ""],
    queryFn: () => searchUsers(trigger?.prefix ?? ""),
    enabled: trigger !== null && (trigger.prefix?.length ?? 0) >= 1,
    staleTime: 30_000,
  });

  // Synthetic entries (e.g. `@AI`) are filtered by the typed prefix and listed
  // first, then the user search hits. De-dupe by username so a synthetic entry
  // never collides with a real one.
  const matchedExtras = trigger
    ? extraSuggestions.filter((e) =>
        e.username.toLowerCase().startsWith((trigger.prefix ?? "").toLowerCase()),
      )
    : [];
  const extraUsernames = new Set(matchedExtras.map((e) => e.username.toLowerCase()));
  const suggestions: UserHit[] = [
    ...matchedExtras,
    ...userHits.filter((u) => !extraUsernames.has(u.username.toLowerCase())),
  ];

  // Reset selected index when suggestions change
  useEffect(() => {
    setSelectedIndex(0);
  }, [suggestions]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      onChange(newValue);
      setTrigger(detectMentionTrigger(newValue));
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // When the autocomplete dropdown is open it owns the navigation keys; only
      // then do we intercept. Otherwise defer to the caller's handler (e.g. the
      // discussion composer's Enter-to-send) so reuse stays non-breaking.
      if (!trigger || suggestions.length === 0) {
        onKeyDownProp?.(e);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (suggestions[selectedIndex]) {
          e.preventDefault();
          insertMention(suggestions[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        setTrigger(null);
      } else {
        onKeyDownProp?.(e);
      }
    },
    [trigger, suggestions, selectedIndex, onKeyDownProp],
  );

  function insertMention(user: UserHit) {
    if (!trigger || !textareaRef.current) return;
    const before = value.slice(0, trigger.triggerStart);
    const after = value.slice(trigger.triggerStart + 1 + trigger.prefix.length);
    const newValue = `${before}@${user.username} ${after}`;
    onChange(newValue);
    setTrigger(null);
    // Restore focus after React state update
    setTimeout(() => {
      if (textareaRef.current) {
        const pos = before.length + 1 + user.username.length + 1;
        textareaRef.current.setSelectionRange(pos, pos);
        textareaRef.current.focus();
      }
    }, 0);
  }

  const showDropdown = trigger !== null && suggestions.length > 0;

  return (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={showDropdown}
      />
      {showDropdown && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover shadow-md"
          aria-label="User suggestions"
        >
          {suggestions.map((user, idx) => (
            <li
              key={user.id}
              role="option"
              aria-selected={idx === selectedIndex}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm",
                idx === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent hover:text-accent-foreground",
              )}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur
                insertMention(user);
              }}
            >
              <span className="font-medium">@{user.username}</span>
              {user.displayName !== user.username && (
                <span className="text-muted-foreground">{user.displayName}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
