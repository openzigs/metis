/**
 * Workbench chat — markdown rendering + project-scoped (RAG) session wiring.
 *
 * Covers the fix where the Workbench chat now renders assistant replies via
 * ChatMarkdown (markdown + mermaid) instead of raw `whitespace-pre-wrap` text,
 * and confirms that selecting a project re-opens the session with `projectId`
 * so server-side auto-RAG retrieval is scoped to that project.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";
import type { StreamEvent } from "@/lib/ai-client";

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

import WorkbenchPage from "@/app/(authed)/workbench/page";
import * as aiClient from "@/lib/ai-client";
import { projectsApi, documentsApi } from "@/lib/projects-api";

const projectsListMock = projectsApi.list as unknown as ReturnType<typeof vi.fn>;
const documentsListMock = documentsApi.list as unknown as ReturnType<typeof vi.fn>;
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
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    // The workbench auto-selects the first project on load, so the session must
    // be (re)opened with that projectId — the server uses it to attach
    // project-scoped RAG context to the conversation.
    await waitFor(() =>
      expect(
        createSessionMock.mock.calls.some((call) => {
          const arg = call[0] as { projectId?: string | null } | undefined;
          return arg?.projectId === "p1";
        }),
      ).toBe(true),
    );

    // Switching the project re-opens the session bound to the new project.
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("workbench-project-picker")).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId("workbench-project-picker"), "");
    await waitFor(() =>
      expect(
        createSessionMock.mock.calls.some((call) => {
          const arg = call[0] as { projectId?: string | null } | undefined;
          return arg?.projectId === undefined;
        }),
      ).toBe(true),
    );
  });

  it("shows connector/repo documents by basename, not the raw connector path", async () => {
    documentsListMock.mockResolvedValue({
      items: [
        {
          id: "doc-repo",
          filename:
            "connector:repo:cmexample0000000000acmerp:src/main/java/com/acme/wms/common/vo/ShipmentSourceVO.java",
          status: "ready",
        },
      ],
    });

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    // The scannable basename is shown as part of the friendly `basename — repo`
    // label (issue #427), not the raw connector path.
    await waitFor(() =>
      expect(screen.getByText(/ShipmentSourceVO\.java — acmerp/)).toBeInTheDocument(),
    );
    // …and the noisy connector prefix never appears as visible text.
    expect(screen.queryByText(/connector:repo:/)).not.toBeInTheDocument();
    // The full original string is preserved as a hover title for traceability.
    const row = screen.getByTestId("workbench-doc-doc-repo");
    expect(row.querySelector('[title^="connector:repo:"]')).not.toBeNull();
  });
});
