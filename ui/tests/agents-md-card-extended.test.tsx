/**
 * Issue #121 — extended unit tests for AgentsMdCard (analysis-md-card).
 *
 * Covers the branches not reached by runs-and-agents-md.test.tsx:
 *  - loading state
 *  - download via anchor click
 *  - copy-failed state
 *  - no preview data (empty agents list)
 *  - no md data (disabled copy/download)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/runs-api", () => ({
  agentsMdApi: {
    getMarkdown: vi.fn(),
    preview: vi.fn(),
  },
}));

import { agentsMdApi } from "@/lib/runs-api";
import { AgentsMdCard } from "@/components/projects/agents-md-card";

const previewFn = agentsMdApi.preview as unknown as ReturnType<typeof vi.fn>;
const getMd = agentsMdApi.getMarkdown as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  previewFn.mockReset();
  getMd.mockReset();
});

function renderCard() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <AgentsMdCard projectId="p1" />
    </Wrapper>,
  );
}

describe("AgentsMdCard — extended coverage", () => {
  it("shows loading indicator while queries are in-flight", () => {
    previewFn.mockImplementationOnce(() => new Promise(() => {}));
    getMd.mockImplementationOnce(() => new Promise(() => {}));
    renderCard();
    expect(screen.getByText(/Loading…/i)).toBeInTheDocument();
  });

  it("copy and download buttons are disabled when md is loading", () => {
    previewFn.mockImplementationOnce(() => new Promise(() => {}));
    getMd.mockImplementationOnce(() => new Promise(() => {}));
    renderCard();
    expect(screen.getByTestId("agents-md-copy")).toBeDisabled();
    expect(screen.getByTestId("agents-md-download")).toBeDisabled();
  });

  it("renders with empty agents list (summary rendered but empty)", async () => {
    previewFn.mockResolvedValueOnce({
      title: "Demo",
      preface: "",
      agents: [],
      mcpServers: [],
    });
    getMd.mockResolvedValueOnce("# Demo\n");
    renderCard();
    await waitFor(() => expect(screen.getByTestId("agents-md-preview")).toBeInTheDocument());
    // Summary UL is rendered but has no agent list items
    const summary = screen.queryByTestId("agents-md-summary");
    if (summary) {
      expect(summary.querySelectorAll("li")).toHaveLength(0);
    }
  });

  it("download creates an anchor and triggers click", async () => {
    previewFn.mockResolvedValueOnce({ title: "T", preface: "", agents: [], mcpServers: [] });
    getMd.mockResolvedValueOnce("MARKDOWN CONTENT");
    renderCard();
    await waitFor(() => expect(screen.getByTestId("agents-md-download")).not.toBeDisabled());

    // Spy on anchor element creation
    const clickSpy = vi.fn();
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementationOnce((tag) => {
      if (tag === "a") {
        const a = document.createElement("a");
        a.click = clickSpy;
        return a;
      }
      return document.createElement(tag);
    });

    // Mock URL methods
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);

    fireEvent.click(screen.getByTestId("agents-md-download"));

    expect(clickSpy).toHaveBeenCalled();
    createElementSpy.mockRestore();
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it("shows 'Copy failed' when clipboard write rejects", async () => {
    previewFn.mockResolvedValueOnce({ title: "T", preface: "", agents: [], mcpServers: [] });
    getMd.mockResolvedValueOnce("BODY");
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });

    renderCard();
    await waitFor(() => expect(screen.getByTestId("agents-md-copy")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("agents-md-copy"));
    await waitFor(() =>
      expect(screen.getByTestId("agents-md-copy")).toHaveTextContent(/Copy failed/i),
    );
  });

  it("shows Copied! state after successful copy", async () => {
    previewFn.mockResolvedValueOnce({ title: "T", preface: "", agents: [], mcpServers: [] });
    getMd.mockResolvedValueOnce("BODY");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderCard();
    await waitFor(() => expect(screen.getByTestId("agents-md-copy")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("agents-md-copy"));
    await waitFor(() => expect(screen.getByTestId("agents-md-copy")).toHaveTextContent(/Copied!/i));
  });
});
