import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { AgentPicker, loadStoredAgentKey, storeAgentKey } from "@/components/chat/agent-picker";

// #236 — the picker reads what a session may bind from the server, which
// already leaves out disabled and archived agents (see the server's
// chat-custom-agent-real-providers.sqlite.test.ts).
vi.mock("@/lib/ai-client", () => ({
  listSessionAgents: vi.fn().mockResolvedValue([
    {
      ref: "library:a1",
      kind: "library",
      key: "researcher",
      name: "Researcher",
      description: "",
    },
  ]),
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
  it("renders the bindable agents and calls onChange with the picked key", async () => {
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
    fireEvent.change(select, { target: { value: "researcher" } });
    expect(onChange).toHaveBeenCalledWith("researcher");
  });
});
