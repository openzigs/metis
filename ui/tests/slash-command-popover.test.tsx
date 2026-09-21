/**
 * Unit tests for the SlashCommandPopover component.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, renderHook, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SlashCommandPopover,
  useSlashCommandKeyboard,
} from "@/components/chat/slash-command-popover";
import type { SlashSuggestion } from "@/components/chat/slash-commands";

describe("SlashCommandPopover", () => {
  it("renders nothing when buffer does not start with /", () => {
    const { container } = render(<SlashCommandPopover buffer="hello" onSelect={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when buffer is empty", () => {
    const { container } = render(<SlashCommandPopover buffer="" onSelect={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders suggestions when buffer starts with /", () => {
    render(<SlashCommandPopover buffer="/" onSelect={vi.fn()} />);
    expect(screen.getByTestId("slash-command-popover")).toBeInTheDocument();
    // All commands should show for just "/"
    expect(screen.getByTestId("slash-suggestion-specify")).toBeInTheDocument();
    expect(screen.getByTestId("slash-suggestion-plan")).toBeInTheDocument();
    expect(screen.getByTestId("slash-suggestion-tasks")).toBeInTheDocument();
  });

  it("filters suggestions by partial match", () => {
    render(<SlashCommandPopover buffer="/sp" onSelect={vi.fn()} />);
    expect(screen.getByTestId("slash-suggestion-specify")).toBeInTheDocument();
    expect(screen.queryByTestId("slash-suggestion-plan")).not.toBeInTheDocument();
  });

  it("calls onSelect with the command when a suggestion is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SlashCommandPopover buffer="/pl" onSelect={onSelect} />);

    await user.click(screen.getByTestId("slash-suggestion-plan"));
    expect(onSelect).toHaveBeenCalledWith("/plan ");
  });

  it("renders nothing when no commands match the partial", () => {
    const { container } = render(<SlashCommandPopover buffer="/xyz" onSelect={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("sets role=listbox on the list and role=option on items", () => {
    render(<SlashCommandPopover buffer="/" onSelect={vi.fn()} />);
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
  });

  it("highlights the first item by default with aria-selected", () => {
    render(<SlashCommandPopover buffer="/" onSelect={vi.fn()} />);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
  });
});

describe("useSlashCommandKeyboard", () => {
  it("ArrowDown advances highlighted index", () => {
    const setHighlightedIndex = vi.fn();
    const suggestions: SlashSuggestion[] = [
      { command: "specify", hint: "Generate spec" },
      { command: "plan", hint: "Run architect" },
    ];
    const { result } = renderHook(() =>
      useSlashCommandKeyboard({
        suggestions,
        highlightedIndex: 0,
        setHighlightedIndex,
        onSelect: vi.fn(),
      }),
    );
    const event = { key: "ArrowDown", preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
    act(() => result.current.onKeyDown(event));
    expect(setHighlightedIndex).toHaveBeenCalledWith(1);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("ArrowUp wraps to last item from index 0", () => {
    const setHighlightedIndex = vi.fn();
    const suggestions: SlashSuggestion[] = [
      { command: "specify", hint: "Generate spec" },
      { command: "plan", hint: "Run architect" },
      { command: "tasks", hint: "Produce tasks" },
    ];
    const { result } = renderHook(() =>
      useSlashCommandKeyboard({
        suggestions,
        highlightedIndex: 0,
        setHighlightedIndex,
        onSelect: vi.fn(),
      }),
    );
    const event = { key: "ArrowUp", preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
    act(() => result.current.onKeyDown(event));
    expect(setHighlightedIndex).toHaveBeenCalledWith(2);
  });

  it("Enter selects the highlighted command", () => {
    const onSelect = vi.fn();
    const suggestions: SlashSuggestion[] = [
      { command: "specify", hint: "Generate spec" },
      { command: "plan", hint: "Run architect" },
    ];
    const { result } = renderHook(() =>
      useSlashCommandKeyboard({
        suggestions,
        highlightedIndex: 1,
        setHighlightedIndex: vi.fn(),
        onSelect,
      }),
    );
    const event = { key: "Enter", preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
    act(() => result.current.onKeyDown(event));
    expect(onSelect).toHaveBeenCalledWith("/plan ");
  });

  it("Escape calls onDismiss", () => {
    const onDismiss = vi.fn();
    const suggestions: SlashSuggestion[] = [{ command: "specify", hint: "Generate spec" }];
    const { result } = renderHook(() =>
      useSlashCommandKeyboard({
        suggestions,
        highlightedIndex: 0,
        setHighlightedIndex: vi.fn(),
        onSelect: vi.fn(),
        onDismiss,
      }),
    );
    const event = { key: "Escape", preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
    act(() => result.current.onKeyDown(event));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("does nothing when suggestions are empty", () => {
    const setHighlightedIndex = vi.fn();
    const onSelect = vi.fn();
    const { result } = renderHook(() =>
      useSlashCommandKeyboard({
        suggestions: [],
        highlightedIndex: 0,
        setHighlightedIndex,
        onSelect,
      }),
    );
    const event = { key: "ArrowDown", preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
    act(() => result.current.onKeyDown(event));
    expect(setHighlightedIndex).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
