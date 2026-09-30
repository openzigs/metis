/**
 * Issue #121 extended — tests for workbench message with context (covering
 * composeWithContext branches) and the pane separators (#526), and the
 * document list being parsed once per change of the list (#526).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";
import type { StreamEvent } from "@/lib/ai-client";

// #526 — the document list is virtualised; jsdom has no layout (see the stub).
vi.mock("@tanstack/react-virtual", async () => (await import("./virtualizer-stub")).module);

// #142 — the page joins its session's socket room; no real socket in unit tests.
vi.mock("@/lib/socket-client", () => ({ useSocket: () => null }));

vi.mock("@/lib/ai-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-client")>("@/lib/ai-client");
  return { ...actual, createSession: vi.fn(), streamChat: vi.fn() };
});

vi.mock("@/components/chat/agent-picker", () => ({
  AgentPicker: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (v: string | null) => void;
  }) => (
    <select
      data-testid="agent-picker"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">Default</option>
    </select>
  ),
}));

vi.mock("@/lib/projects-api", () => ({
  projectsApi: { list: vi.fn() },
  documentsApi: { list: vi.fn() },
}));

vi.mock("@/lib/analysis-api", () => ({
  analysisApi: { listForProject: vi.fn().mockResolvedValue({ items: [] }) },
}));

vi.mock("@/lib/scheduler-api", () => ({
  tasksApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));

vi.mock("@/lib/recent-tracker", () => ({
  recentTracker: { touch: vi.fn(), list: () => [] },
}));

vi.mock("@/lib/templates", () => ({
  consumeRunPayload: vi.fn().mockReturnValue(null),
}));

vi.mock("@/components/chat/loaded-skills-panel", () => ({
  LoadedSkillsPanel: () => null,
}));

// #526 — counts how often the page parses the document list.
vi.mock("@/lib/workbench-document-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workbench-document-tree")>();
  return { ...actual, toPanelEntries: vi.fn(actual.toPanelEntries) };
});

import WorkbenchPage from "@/app/(authed)/workbench/page";
import * as aiClient from "@/lib/ai-client";
import { projectsApi, documentsApi } from "@/lib/projects-api";
import { toPanelEntries } from "@/lib/workbench-document-tree";

const projectsListMock = projectsApi.list as unknown as ReturnType<typeof vi.fn>;
const documentsListMock = documentsApi.list as unknown as ReturnType<typeof vi.fn>;
const createSessionMock = vi.mocked(aiClient.createSession);
const streamChatMock = vi.mocked(aiClient.streamChat);

const fakeSession: aiClient.AISession = {
  id: "sess-ctx",
  title: "Workbench",
  provider: "bedrock-gateway",
  model: "anthropic.claude-sonnet-4-5",
  policy: { low: "auto", medium: "prompt-once", high: "always-prompt" },
  status: "active",
  projectId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  createSessionMock.mockResolvedValue(fakeSession);
  projectsListMock.mockResolvedValue({ items: [{ id: "p1", name: "Alpha" }] });
  documentsListMock.mockResolvedValue({ items: [] });
});

describe("WorkbenchPage — composeWithContext branches", () => {
  it("sends message with attached context docs (non-empty attachments branch)", async () => {
    const user = userEvent.setup();
    // Setup docs
    documentsListMock.mockResolvedValueOnce({
      items: [{ id: "d1", filename: "spec.md", status: "ready" }],
    });

    // Stream returns a message
    async function* simpleStream(): AsyncGenerator<StreamEvent> {
      yield { type: "delta", content: "Response with context" };
      yield { type: "done" };
    }
    streamChatMock.mockReturnValue(simpleStream());

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    // Wait for document to load and attach it
    await waitFor(() => expect(screen.getByTestId("workbench-doc-attach-d1")).toBeInTheDocument());
    await user.click(screen.getByTestId("workbench-doc-attach-d1"));
    await waitFor(() => expect(screen.getByTestId("workbench-context-chips")).toBeInTheDocument());

    // Wait for input to be enabled
    await waitFor(() => expect(screen.getByTestId("workbench-input")).not.toBeDisabled());

    // Type and send message
    await user.type(screen.getByTestId("workbench-input"), "analyze this");
    await user.click(screen.getByTestId("workbench-send"));

    // streamChat should have been called with composed message (including context)
    await waitFor(() => expect(streamChatMock).toHaveBeenCalled());
    const call = streamChatMock.mock.calls[0];
    // #136 — only the new (composed) message is sent; the server keeps history.
    const message = call[1] as string;
    expect(message).toContain("analyze this");
    // With context, the message should include "Context attachments"
    expect(message).toContain("Context attachments");
  });

  it("sends message without context docs (empty attachments branch)", async () => {
    const user = userEvent.setup();
    documentsListMock.mockResolvedValueOnce({ items: [] });

    async function* simpleStream(): AsyncGenerator<StreamEvent> {
      yield { type: "delta", content: "Response no context" };
      yield { type: "done" };
    }
    streamChatMock.mockReturnValue(simpleStream());

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByTestId("workbench-input")).not.toBeDisabled());

    await user.type(screen.getByTestId("workbench-input"), "hello");
    await user.click(screen.getByTestId("workbench-send"));

    await waitFor(() => expect(streamChatMock).toHaveBeenCalled());
    const call = streamChatMock.mock.calls[0];
    // Without context, the message should be just the raw input
    expect(call[1]).toBe("hello");
  });

  // #526 — attaching and detaching re-filter the parsed entries; only a new
  // document list is parsed again.
  it("parses the document list once, however often a document is attached or detached", async () => {
    const user = userEvent.setup();
    documentsListMock.mockResolvedValue({
      items: [
        { id: "d1", filename: "spec.md", status: "ready" },
        { id: "d2", filename: "notes.md", status: "ready" },
      ],
    });
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByTestId("workbench-doc-attach-d2")).toBeInTheDocument());
    const parses = vi.mocked(toPanelEntries).mock.calls.length;

    await user.click(screen.getByTestId("workbench-doc-attach-d1"));
    await user.click(screen.getByTestId("workbench-doc-attach-d2"));
    const chips = await screen.findByTestId("workbench-context-chips");
    await user.click(within(chips).getByRole("listitem", { name: "Remove spec.md from context" }));

    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((c) => c.textContent),
    ).toEqual([expect.stringContaining("notes.md")]);
    expect(screen.getByTestId("workbench-doc-attach-d1")).toHaveTextContent("Attach");
    expect(screen.getByTestId("workbench-doc-attach-d2")).toHaveTextContent("Attached");
    expect(vi.mocked(toPanelEntries).mock.calls.length).toBe(parses);
  });

  it("resizes the side panes from their separators, and keeps the widths", async () => {
    const user = userEvent.setup();
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    const left = await screen.findByRole("separator", { name: "Resize documents panel" });
    const right = screen.getByRole("separator", { name: "Resize recent panel" });
    expect(left).toHaveAttribute("aria-controls", "workbench-left-panel");
    expect(screen.getByTestId("workbench-left-panel")).toHaveAttribute(
      "id",
      "workbench-left-panel",
    );
    expect(right).toHaveAttribute("aria-controls", "workbench-right-panel");
    expect(screen.getByTestId("workbench-right-panel")).toHaveAttribute(
      "id",
      "workbench-right-panel",
    );
    expect(left).toHaveAttribute("aria-valuenow", "22");

    left.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    right.focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");

    expect(left).toHaveAttribute("aria-valuenow", "24");
    expect(right).toHaveAttribute("aria-valuenow", "21");
    const grid = left.parentElement as HTMLElement;
    expect(grid.style.getPropertyValue("--wb-left")).toBe("24%");
    expect(grid.style.getPropertyValue("--wb-right")).toBe("21%");
    const saved = JSON.parse(window.localStorage.getItem("metis.workbench.layout") ?? "{}");
    expect(saved).toMatchObject({ leftPct: 24, rightPct: 21 });
  });

  it("drags a separator by a share of the panes' width", async () => {
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });
    const left = await screen.findByRole("separator", { name: "Resize documents panel" });
    const grid = left.parentElement as HTMLElement;
    vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);

    fireEvent.pointerDown(left, { button: 0, clientX: 220 });
    fireEvent.pointerMove(window, { clientX: 320 });
    expect(left).toHaveAttribute("aria-valuenow", "32");
    fireEvent.pointerUp(window, { clientX: 320 });
    fireEvent.pointerMove(window, { clientX: 500 });
    expect(left).toHaveAttribute("aria-valuenow", "32");
  });

  // #526 review — the panes follow every move, but the layout is written to
  // localStorage once, when the drag ends, not synchronously per pointermove.
  it("moves the panes live during a drag and saves the layout once, at its end", async () => {
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });
    const left = await screen.findByRole("separator", { name: "Resize documents panel" });
    const grid = left.parentElement as HTMLElement;
    vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const layoutWrites = () =>
      setItem.mock.calls.filter(([key]) => key === "metis.workbench.layout").length;

    fireEvent.pointerDown(left, { button: 0, clientX: 220 });
    for (let x = 221; x <= 320; x++) fireEvent.pointerMove(window, { clientX: x });
    // The pane followed the pointer…
    expect(grid.style.getPropertyValue("--wb-left")).toBe("32%");
    expect(left).toHaveAttribute("aria-valuenow", "32");
    // …without a single write for the hundred moves.
    expect(layoutWrites()).toBe(0);

    fireEvent.pointerUp(window, { clientX: 320 });
    expect(layoutWrites()).toBe(1);
    expect(JSON.parse(window.localStorage.getItem("metis.workbench.layout") ?? "{}")).toMatchObject(
      { leftPct: 32, rightPct: 26 },
    );
    expect(grid.style.getPropertyValue("--wb-left")).toBe("32%");
    setItem.mockRestore();
  });
});
