/**
 * Workbench chat — markdown rendering + project-scoped (RAG) session wiring.
 *
 * Covers the fix where the Workbench chat now renders assistant replies via
 * ChatMarkdown (markdown + mermaid) instead of raw `whitespace-pre-wrap` text,
 * and confirms that selecting a project re-opens the session with `projectId`
 * so server-side auto-RAG retrieval is scoped to that project.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  documentsApi: { list: vi.fn(), listAfter: vi.fn() },
}));

// #23 — the Workbench resolves connector ids to repository names.
const repoListMock = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { list: (...args: unknown[]) => repoListMock(...args) },
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

import WorkbenchPage from "@/app/(authed)/workbench/page";
import * as aiClient from "@/lib/ai-client";
import { projectsApi, documentsApi } from "@/lib/projects-api";

const projectsListMock = projectsApi.list as unknown as ReturnType<typeof vi.fn>;
const documentsListMock = documentsApi.list as unknown as ReturnType<typeof vi.fn>;
const documentsListAfterMock = documentsApi.listAfter as unknown as ReturnType<typeof vi.fn>;
const createSessionMock = vi.mocked(aiClient.createSession);
const streamChatMock = vi.mocked(aiClient.streamChat);

const fakeSession: aiClient.AISession = {
  id: "sess-render",
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

describe("WorkbenchPage — chat rendering & RAG scope", () => {
  it("renders an assistant markdown reply as HTML, not raw markdown text", async () => {
    const user = userEvent.setup();

    async function* markdownStream(): AsyncGenerator<StreamEvent> {
      yield { type: "delta", content: "## Business Rules\n\n" };
      yield { type: "delta", content: "- first rule\n- second rule\n" };
      yield { type: "done" };
    }
    streamChatMock.mockReturnValue(markdownStream());

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByTestId("workbench-input")).not.toBeDisabled());
    await user.type(screen.getByTestId("workbench-input"), "list the rules");
    await user.click(screen.getByTestId("workbench-send"));

    // The markdown heading should be rendered as a real heading element, and
    // the bullets as list items — proving ChatMarkdown ran (not raw text).
    const heading = await screen.findByRole("heading", { name: /business rules/i });
    expect(heading).toBeInTheDocument();
    const items = await screen.findAllByRole("listitem");
    expect(items.some((li) => /first rule/i.test(li.textContent ?? ""))).toBe(true);

    // The raw markdown markers must not survive as literal text.
    expect(screen.queryByText(/## Business Rules/)).not.toBeInTheDocument();
  });

  it("opens the session scoped to the active project so RAG is project-bound", async () => {
    async function* reply(): AsyncGenerator<StreamEvent> {
      yield { type: "done" };
    }
    streamChatMock.mockImplementation(() => reply());
    const user = userEvent.setup();
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    // The workbench auto-selects the first project on load; the session opened
    // by the first send (#361) carries that projectId — the server uses it to
    // attach project-scoped RAG context to the conversation.
    await waitFor(() => expect(screen.getByTestId("workbench-project-picker")).toHaveValue("p1"));
    await user.type(screen.getByTestId("workbench-input"), "hi");
    await user.click(screen.getByTestId("workbench-send"));
    await waitFor(() => expect(createSessionMock).toHaveBeenCalledTimes(1));
    expect((createSessionMock.mock.calls[0]![0] as { projectId?: string }).projectId).toBe("p1");

    // Switching the project drops the session; the next send opens one bound to
    // the new scope (here: no project).
    await waitFor(() => expect(screen.getByTestId("workbench-send")).toHaveTextContent("Send"));
    await user.selectOptions(screen.getByTestId("workbench-project-picker"), "");
    await user.type(screen.getByTestId("workbench-input"), "again");
    await user.click(screen.getByTestId("workbench-send"));
    await waitFor(() => expect(createSessionMock).toHaveBeenCalledTimes(2));
    expect(
      (createSessionMock.mock.calls[1]![0] as { projectId?: string }).projectId,
    ).toBeUndefined();
  });

  it("shows a repository file by name in its folder, never by the raw connector key (#363, #32)", async () => {
    const user = userEvent.setup();
    documentsListMock.mockResolvedValue({
      items: [
        {
          id: "doc-repo",
          source: "repo",
          // #717 — keyed as connector-ingest.ts keys the repo file
          // `src/main/java/…`: the first `src/` is the ingester's marker.
          filename:
            "connector:repo:cmexample0000000000acmerp:src/src/main/java/com/acme/wms/common/vo/ShipmentSourceVO.java",
          status: "ready",
        },
      ],
    });

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    // #32 — repository files start collapsed under their repository; filtering
    // opens every folder on a match's path.
    await user.type(await screen.findByTestId("workbench-doc-filter"), "ShipmentSource");
    const row = await screen.findByTestId("workbench-doc-doc-repo");
    expect(row).toHaveTextContent("ShipmentSourceVO.java");
    // The noisy connector prefix appears nowhere, not even in the tooltip.
    expect(screen.queryByText(/connector:repo:/)).not.toBeInTheDocument();
    expect(row.querySelector('[title*="connector:repo:"]')).toBeNull();
    // The full path is on hover.
    expect(
      row.querySelector('[title$="src/main/java/com/acme/wms/common/vo/ShipmentSourceVO.java"]'),
    ).not.toBeNull();
  });

  it("names the repository folder with the repository's name when it is known (#23, #32)", async () => {
    repoListMock.mockResolvedValueOnce([
      { id: "cmexample0000000000acmerp", repoName: "wms-core", label: "WMS" },
    ]);
    documentsListMock.mockResolvedValue({
      items: [
        {
          id: "doc-repo",
          source: "repo",
          filename: "connector:repo:cmexample0000000000acmerp:README.md",
          status: "ready",
        },
      ],
    });

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    const folder = await screen.findByRole("button", { name: /wms-core/ });
    expect(folder.closest("li")).toHaveAttribute("data-group", "repos");
    expect(screen.getByRole("tree", { name: "Documents" }).textContent).not.toContain("acmerp");
  });

  it("reaches a document past the first page — the panel is no longer capped at 50 (#32)", async () => {
    const user = userEvent.setup();
    const all = Array.from({ length: 150 }, (_, i) => ({
      id: `d${i}`,
      filename: `upload-${i}.md`,
      status: "ready",
    }));
    // #440 — the panel follows the server's cursor; here the cursor is the offset.
    const pageAt = (offset: number, limit: number) => ({
      items: all.slice(offset, offset + limit),
      limit,
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
    });
    documentsListMock.mockImplementation(async (_p: string, params?: { limit?: number }) => ({
      ...pageAt(0, params?.limit ?? 25),
      total: all.length,
      offset: 0,
    }));
    documentsListAfterMock.mockImplementation(
      async (_p: string, cursor: string, params?: { limit?: number }) =>
        pageAt(Number(cursor), params?.limit ?? 25),
    );

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await user.type(await screen.findByTestId("workbench-doc-filter"), "upload-149");
    await user.click(await screen.findByTestId("workbench-doc-attach-d149"));
    const chips = await screen.findByTestId("workbench-context-chips");
    expect(within(chips).getByText(/upload-149\.md/)).toBeInTheDocument();
  });

  it("says the documents failed to load rather than showing an empty project (#32)", async () => {
    documentsListMock.mockRejectedValue(new Error("boom"));
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load");
    expect(screen.queryByText("No documents yet")).toBeNull();
  });

  // PR #367 panel — the context chip is a second render site for the label, and
  // reverting it alone left every Workbench test green.
  it("labels an attached context chip with the repository's name (#23)", async () => {
    const user = userEvent.setup();
    repoListMock.mockResolvedValueOnce([
      { id: "cmexample0000000000acmerp", repoName: "wms-core", label: "WMS" },
    ]);
    documentsListMock.mockResolvedValue({
      items: [
        {
          id: "doc-repo",
          source: "repo",
          filename: "connector:repo:cmexample0000000000acmerp:README.md",
          status: "ready",
        },
      ],
    });

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: /wms-core/ }));
    await user.click(screen.getByTestId("workbench-doc-attach-doc-repo"));

    const chips = await screen.findByTestId("workbench-context-chips");
    expect(
      within(chips).getByRole("listitem", { name: "Remove README.md — wms-core from context" }),
    ).toBeInTheDocument();
  });

  // #474 — the panel numbered its unnamed-repository groups but the chips did
  // not, so two repositories' READMEs both read "README.md — Unnamed repository".
  it("labels a chip with its panel group's ordinal when two repositories are unnamed (#474)", async () => {
    const user = userEvent.setup();
    repoListMock.mockResolvedValueOnce([]);
    documentsListMock.mockResolvedValue({
      items: [
        {
          id: "doc-a",
          source: "repo",
          filename: "connector:repo:cmexample0000000000aaaaaa:README.md",
          status: "ready",
        },
        {
          id: "doc-b",
          source: "repo",
          filename: "connector:repo:cmexample0000000000bbbbbb:README.md",
          status: "ready",
        },
      ],
    });

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    // Attach only the second repository's README: the chip is numbered from the
    // whole list, as the panel is, not from what is attached.
    await user.click(await screen.findByRole("button", { name: /Unnamed repository 2/ }));
    await user.click(screen.getByTestId("workbench-doc-attach-doc-b"));

    const chips = await screen.findByTestId("workbench-context-chips");
    const chip = within(chips).getByRole("listitem", {
      name: "Remove README.md — Unnamed repository 2 from context",
    });
    expect(chip).toHaveAttribute("title", "Unnamed repository 2/README.md");
  });

  it("labels a chip for an unnamed repository without an id fragment (#440)", async () => {
    const user = userEvent.setup();
    repoListMock.mockResolvedValueOnce([]);
    documentsListMock.mockResolvedValue({
      items: [
        {
          id: "doc-repo",
          source: "repo",
          filename: "connector:repo:cmexample0000000000acmerp:README.md",
          status: "ready",
        },
      ],
    });

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: /Unnamed repository/ }));
    await user.click(screen.getByTestId("workbench-doc-attach-doc-repo"));

    const chips = await screen.findByTestId("workbench-context-chips");
    const chip = within(chips).getByRole("listitem", {
      name: "Remove README.md — Unnamed repository from context",
    });
    expect(chips.textContent).not.toContain("acmerp");
    expect(chip.getAttribute("title")).not.toContain("acmerp");
  });
});
