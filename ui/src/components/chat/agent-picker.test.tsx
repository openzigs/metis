/**
 * #236 — ONE agent picker for both kinds of agent. Before #236 the picker
 * listed library agents only (`agentsApi.list()`), so a project's custom agent
 * could never be a chat session's agent. It now lists what the server says a
 * session may bind — library agents, plus the project's custom agents — and
 * the page turns the choice into the right session-create field.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  apiFetch,
  ApiError: class extends Error {},
  streamFetch: vi.fn(),
}));

import { AgentPicker } from "./agent-picker";
import { sessionAgentInput } from "@/lib/ai-client";

const ITEMS = [
  { ref: "library:a-lead", kind: "library", key: "lead", name: "Lead", description: "" },
  { ref: "custom:c-helper", kind: "custom", key: "helper", name: "Helper", description: "" },
];

function renderPicker(props: { projectId?: string | null; value?: string | null } = {}) {
  const onChange = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AgentPicker value={props.value ?? null} onChange={onChange} projectId={props.projectId} />
    </QueryClientProvider>,
  );
  return { onChange };
}

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("AgentPicker (#236)", () => {
  it("lists library and project agents from the session-agents endpoint, for the session's project", async () => {
    apiFetch.mockResolvedValue({ items: ITEMS });
    const { onChange } = renderPicker({ projectId: "p-1" });
    const select = screen.getByTestId("agent-picker") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(apiFetch).toHaveBeenCalledWith("/ai/session-agents?projectId=p-1");
    expect(screen.getByRole("group", { name: "Library agents" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Project agents" })).toBeTruthy();
    const values = [...select.options].map((o) => o.value);
    // A library agent by KEY (a stored pre-#236 choice still matches); a custom one by REF.
    expect(values).toEqual(["", "lead", "custom:c-helper"]);
    fireEvent.change(select, { target: { value: "custom:c-helper" } });
    expect(onChange).toHaveBeenCalledWith("custom:c-helper");
  });

  it("asks for library agents only when the session has no single project", async () => {
    apiFetch.mockResolvedValue({ items: ITEMS.slice(0, 1) });
    renderPicker({ projectId: null });
    const select = screen.getByTestId("agent-picker") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(apiFetch).toHaveBeenCalledWith("/ai/session-agents");
    expect(screen.queryByRole("group", { name: "Project agents" })).toBeNull();
  });
});

describe("sessionAgentInput (#236)", () => {
  it("sends a library KEY as agentKey and any ref as agentRef", () => {
    expect(sessionAgentInput("lead", null)).toEqual({ agentKey: "lead" });
    expect(sessionAgentInput("library:a-lead", null)).toEqual({ agentRef: "library:a-lead" });
    expect(sessionAgentInput("custom:c-helper", "p-1")).toEqual({ agentRef: "custom:c-helper" });
  });

  it("drops a custom agent when there is no project to run it in, and nothing selected is nothing sent", () => {
    expect(sessionAgentInput("custom:c-helper", null)).toEqual({});
    expect(sessionAgentInput(null, "p-1")).toEqual({});
  });
});
