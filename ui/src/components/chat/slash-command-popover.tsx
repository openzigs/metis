"use client";

/**
 * Reusable slash-command autocomplete popover for chat-style input surfaces.
 *
 * Shows suggestions when the input buffer starts with `/`. Clicking a
 * suggestion fills the input with the selected command.
 *
 * Keyboard navigation: Arrow Up/Down to navigate, Enter to select, Escape to dismiss.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { suggestSlashCommands, type SlashSuggestion } from "./slash-commands";

interface Props {
  buffer: string;
  onSelect: (command: string) => void;
}

export function SlashCommandPopover({ buffer, onSelect }: Props) {
  const suggestions = useMemo(() => suggestSlashCommands(buffer), [buffer]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  // Reset highlighted index when suggestions change
  useEffect(() => {
    setHighlightedIndex(0);
  }, [suggestions.length, buffer]);

  if (suggestions.length === 0) return null;

  return (
    <ul
      className="absolute bottom-full left-0 z-10 mb-1 w-full rounded border bg-popover p-1 shadow-md"
      data-testid="slash-command-popover"
      role="listbox"
      aria-label="Slash command suggestions"
    >
      {suggestions.map((s: SlashSuggestion, idx: number) => (
        <li key={s.command} role="option" aria-selected={idx === highlightedIndex}>
          <button
            type="button"
            data-testid={`slash-suggestion-${s.command}`}
            onClick={() => onSelect(`/${s.command} `)}
            className={`flex w-full justify-between rounded px-2 py-1 text-left text-xs hover:bg-accent ${idx === highlightedIndex ? "bg-accent" : ""}`}
          >
            <span className="font-mono font-medium">/{s.command}</span>
            <span className="text-muted-foreground">{s.hint}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Hook that provides a keyboard event handler for the parent input element.
 * Wire the returned `onKeyDown` to the input that triggers the popover.
 */
export function useSlashCommandKeyboard(opts: {
  suggestions: SlashSuggestion[];
  highlightedIndex: number;
  setHighlightedIndex: (idx: number) => void;
  onSelect: (command: string) => void;
  onDismiss?: () => void;
}) {
  const { suggestions, highlightedIndex, setHighlightedIndex, onSelect, onDismiss } = opts;

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (suggestions.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((highlightedIndex + 1) % suggestions.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((highlightedIndex - 1 + suggestions.length) % suggestions.length);
          break;
        case "Enter":
          e.preventDefault();
          onSelect(`/${suggestions[highlightedIndex].command} `);
          break;
        case "Escape":
          e.preventDefault();
          onDismiss?.();
          break;
      }
    },
    [suggestions, highlightedIndex, setHighlightedIndex, onSelect, onDismiss],
  );

  return { onKeyDown };
}
