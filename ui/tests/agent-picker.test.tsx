import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { AgentPicker, loadStoredAgentKey, storeAgentKey } from "@/components/chat/agent-picker";

vi.mock("@/lib/library-api", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue({
      items: [
        {
          id: "a1",
          key: "researcher",
          name: "Researcher",
          displayName: "Researcher",
          description: "",
          version: "1.0.0",
          model: "gpt",
          tools: [],
          tags: [],
          handoffs: [],
          enabled: true,
          archived: false,
          source: "inline",
          contentSha256: null,
          defaultSkillKeys: [],
          createdById: null,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "a2",
          key: "writer",
          name: "Writer",
          displayName: "Writer",
          description: "",
          version: "1.0.0",
          model: "gpt",
          tools: [],
          tags: [],
          handoffs: [],
          enabled: false, // disabled — should be filtered out
          archived: false,
          source: "inline",
          contentSha256: null,
          defaultSkillKeys: [],
          createdById: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
    }),
  },
}));

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe("agent-picker storage helpers", () => {
  it("round-trips a value through localStorage", () => {
    storeAgentKey("researcher");
    expect(loadStoredAgentKey()).toBe("researcher");
  });
  it("clears when null is passed", () => {
    storeAgentKey("x");
    storeAgentKey(null);
    expect(loadStoredAgentKey()).toBeNull();
  });
});

describe("<AgentPicker />", () => {
  it("renders enabled agents and calls onChange with the picked key", async () => {
    const onChange = vi.fn();
    const Wrapper = makeWrapper({ withAuth: false });
    render(
      <Wrapper>
        <AgentPicker value={null} onChange={onChange} />
      </Wrapper>,
    );
    const select = await screen.findByTestId("agent-picker");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Researcher" })).toBeInTheDocument(),
    );
    // Disabled agent must not appear
    expect(screen.queryByRole("option", { name: "Writer" })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "researcher" } });
    expect(onChange).toHaveBeenCalledWith("researcher");
  });
});
