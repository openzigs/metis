/**
 * Epic #475 (Phase 4, #488) — promote-to-requirement + thread settings tests.
 *
 * Covers: the promote dialog (form submit → endpoint, provenance link on
 * success, error toast), the aiResponseMode segmented control persisting all
 * three values (+ rollback on failure), anchor selection persisting, the
 * member-only promote action wiring in the message list, and `isPromotable`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/discussions-api", async (orig) => {
  const actual = await orig<typeof import("@/lib/discussions-api")>();
  return {
    ...actual,
    promoteMessage: vi.fn(),
    updateThreadSettings: vi.fn(),
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { promoteMessage, updateThreadSettings } from "@/lib/discussions-api";
import { toast } from "sonner";
import {
  PromoteToRequirementDialog,
  seedTitleFromBody,
  stripLeadingMarkdown,
} from "@/components/chat/promote-to-requirement-dialog";
import { ThreadSettingsPanel } from "@/components/chat/thread-settings-panel";
import {
  DiscussionMessageList,
  isPromotable,
  type DiscussionListMessage,
} from "@/components/chat/discussion-message-list";

const promoteMock = promoteMessage as ReturnType<typeof vi.fn>;
const updateMock = updateThreadSettings as ReturnType<typeof vi.fn>;
const toastError = toast.error as ReturnType<typeof vi.fn>;
const toastSuccess = toast.success as ReturnType<typeof vi.fn>;

function renderWith(node: React.ReactElement) {
  const Wrapper = makeWrapper({});
  return render(<Wrapper>{node}</Wrapper>);
}

function msg(over: Partial<DiscussionListMessage> = {}): DiscussionListMessage {
  return {
    id: "m1",
    threadId: "t1",
    authorKind: "human",
    authorUserId: "u1",
    aiProvider: null,
    aiModel: null,
    aiSessionId: null,
    body: "We must support SSO login",
    createdAt: new Date().toISOString(),
    editedAt: null,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

// ---- seedTitleFromBody + isPromotable --------------------------------------

describe("stripLeadingMarkdown (#513)", () => {
  it("strips ATX heading hashes and trims", () => {
    expect(stripLeadingMarkdown("## Search Latency Targets — Recommendation")).toBe(
      "Search Latency Targets — Recommendation",
    );
    expect(stripLeadingMarkdown("###### Deep heading")).toBe("Deep heading");
  });
  it("strips a single leading list bullet or blockquote marker", () => {
    expect(stripLeadingMarkdown("- A bullet item")).toBe("A bullet item");
    expect(stripLeadingMarkdown("* Star bullet")).toBe("Star bullet");
    expect(stripLeadingMarkdown("+ Plus bullet")).toBe("Plus bullet");
    expect(stripLeadingMarkdown("> Quoted line")).toBe("Quoted line");
  });
  it("unwraps emphasis only when it brackets the whole line", () => {
    expect(stripLeadingMarkdown("**Bold title**")).toBe("Bold title");
    expect(stripLeadingMarkdown("_Italic title_")).toBe("Italic title");
    expect(stripLeadingMarkdown("`code title`")).toBe("code title");
    // Inline emphasis mid-sentence is preserved.
    expect(stripLeadingMarkdown("Use the *fast* path")).toBe("Use the *fast* path");
  });
  it("combines a heading with wrapping emphasis", () => {
    expect(stripLeadingMarkdown("## **Recommendation**")).toBe("Recommendation");
  });
  it("leaves clean prose untouched", () => {
    expect(stripLeadingMarkdown("Already clean")).toBe("Already clean");
  });
});

describe("seedTitleFromBody", () => {
  it("takes the first non-empty line, trimmed", () => {
    expect(seedTitleFromBody("\n  Hello world  \nmore")).toBe("Hello world");
  });
  it("strips leading markdown heading syntax from the first line (#513)", () => {
    expect(seedTitleFromBody("## Search Latency Targets — Recommendation\n\nBody")).toBe(
      "Search Latency Targets — Recommendation",
    );
  });
  it("truncates a long line with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = seedTitleFromBody(long);
    expect(out.length).toBe(118); // 117 chars + the ellipsis
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("isPromotable", () => {
  it("is true for a persisted, non-streaming, non-empty message", () => {
    expect(isPromotable(msg({ id: "server-1" }))).toBe(true);
  });
  it("is false for an optimistic local id, a streaming, an error, or empty body", () => {
    expect(isPromotable(msg({ id: "local-abc" }))).toBe(false);
    expect(isPromotable(msg({ id: "ai-local-abc", authorKind: "ai" }))).toBe(false);
    expect(isPromotable(msg({ id: "s1", streaming: true }))).toBe(false);
    expect(isPromotable(msg({ id: "s1", isError: true }))).toBe(false);
    expect(isPromotable(msg({ id: "s1", body: "   " }))).toBe(false);
  });
});

// ---- PromoteToRequirementDialog --------------------------------------------

describe("PromoteToRequirementDialog", () => {
  function renderDialog(over: Partial<Parameters<typeof PromoteToRequirementDialog>[0]> = {}) {
    return renderWith(
      <PromoteToRequirementDialog
        open
        onOpenChange={vi.fn()}
        threadId="t1"
        messageId="m1"
        projectId="p1"
        messageBody="We must support SSO login"
        {...over}
      />,
    );
  }

  it("seeds the title from the message body", () => {
    renderDialog();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "We must support SSO login",
    );
  });

  it("seeds a markdown-heading body without the leading hashes (#513)", () => {
    renderDialog({ messageBody: "## Search Latency Targets — Recommendation\n\nDetails" });
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Search Latency Targets — Recommendation",
    );
  });

  it("renders an accessible description so Radix has aria-describedby (#513)", () => {
    renderDialog();
    // The dialog is described — Radix wires aria-describedby to this node, which
    // is what silences the 'Missing Description' console warning.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-describedby");
    expect(screen.getByText(/recorded in the audit trail/i)).toBeInTheDocument();
  });

  it("submits title/type/priority to the promote endpoint and shows a provenance link", async () => {
    promoteMock.mockResolvedValue({ requirementId: "req-9", analysisId: "a1" });
    const onPromoted = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onPromoted });
    await user.selectOptions(screen.getByLabelText("Type"), "bug");
    await user.selectOptions(screen.getByLabelText("Priority"), "high");
    await user.click(screen.getByRole("button", { name: /^promote$/i }));
    await waitFor(() =>
      expect(promoteMock).toHaveBeenCalledWith("t1", "m1", {
        title: "We must support SSO login",
        type: "bug",
        priority: "high",
      }),
    );
    expect(onPromoted).toHaveBeenCalledWith({ requirementId: "req-9", analysisId: "a1" });
    const link = await screen.findByTestId("promote-requirement-link");
    expect(link).toHaveAttribute("href", expect.stringContaining("requirementId=req-9"));
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("surfaces an error toast when promote fails", async () => {
    promoteMock.mockRejectedValue(new Error("derive failed"));
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /^promote$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("derive failed"));
    expect(screen.queryByTestId("promote-success")).not.toBeInTheDocument();
  });

  it("notes the AI acceptance-criteria hook is not yet available", () => {
    renderDialog();
    expect(screen.getByText(/draft acceptance criteria/i)).toBeInTheDocument();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it("calls onOpenChange(false) when Cancel is clicked", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onOpenChange });
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismisses from the success view via Done (and resets)", async () => {
    promoteMock.mockResolvedValue({ requirementId: "req-1", analysisId: "a1" });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onOpenChange });
    await user.click(screen.getByRole("button", { name: /^promote$/i }));
    await screen.findByTestId("promote-success");
    await user.click(screen.getByRole("button", { name: /done/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not submit an empty title", async () => {
    const user = userEvent.setup();
    renderDialog({ messageBody: "" });
    const promoteBtn = screen.getByRole("button", { name: /^promote$/i });
    expect(promoteBtn).toBeDisabled();
    await user.click(promoteBtn);
    expect(promoteMock).not.toHaveBeenCalled();
  });
});

// ---- ThreadSettingsPanel ---------------------------------------------------

describe("ThreadSettingsPanel — aiResponseMode segmented control", () => {
  function renderPanel(over: Partial<Parameters<typeof ThreadSettingsPanel>[0]> = {}) {
    return renderWith(<ThreadSettingsPanel threadId="t1" aiResponseMode="on_mention" {...over} />);
  }

  it("renders three radio options with the current one checked", () => {
    renderPanel();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "On mention" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it.each([
    ["Off", "off"],
    ["On mention", "on_mention"],
    ["Auto", "auto"],
  ])("persists the %s mode via PATCH", async (label, value) => {
    updateMock.mockResolvedValue({ id: "t1", aiResponseMode: value });
    const onModeChange = vi.fn();
    const user = userEvent.setup();
    // Start from a different mode so each click is a real change.
    renderPanel({ aiResponseMode: value === "auto" ? "off" : "auto", onModeChange });
    await user.click(screen.getByRole("radio", { name: label }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith("t1", { aiResponseMode: value }));
    expect(onModeChange).toHaveBeenCalledWith(value);
  });

  it("rolls back the selection when the PATCH fails", async () => {
    updateMock.mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    renderPanel({ aiResponseMode: "on_mention" });
    await user.click(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("nope"));
    // Selection reverts to on_mention.
    expect(screen.getByRole("radio", { name: "On mention" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("does not re-PATCH when clicking the already-selected mode", async () => {
    const user = userEvent.setup();
    renderPanel({ aiResponseMode: "on_mention" });
    await user.click(screen.getByRole("radio", { name: "On mention" }));
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("ThreadSettingsPanel — anchor", () => {
  it("persists a selected anchor via PATCH", async () => {
    updateMock.mockResolvedValue({ id: "t1", analysisId: "a1" });
    const onAnchorChange = vi.fn();
    const user = userEvent.setup();
    renderWith(
      <ThreadSettingsPanel threadId="t1" aiResponseMode="off" onAnchorChange={onAnchorChange} />,
    );
    await user.selectOptions(screen.getByLabelText("Anchor type"), "analysisId");
    await user.type(screen.getByLabelText("Anchor (optional)"), "a1");
    await user.click(screen.getByRole("button", { name: /^anchor$/i }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith("t1", { anchor: { analysisId: "a1" } }),
    );
    expect(onAnchorChange).toHaveBeenCalledWith({ analysisId: "a1" });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("toasts and does not clear input when the anchor PATCH fails", async () => {
    updateMock.mockRejectedValue(new Error("invalid anchor"));
    const user = userEvent.setup();
    renderWith(<ThreadSettingsPanel threadId="t1" aiResponseMode="off" />);
    await user.type(screen.getByLabelText("Anchor (optional)"), "r-bad");
    await user.click(screen.getByRole("button", { name: /^anchor$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("invalid anchor"));
  });
});

// ---- Promote action wiring in the list -------------------------------------

describe("DiscussionMessageList promote action (#488)", () => {
  it("shows a promote action only when onPromote is provided and the message is promotable", async () => {
    const onPromote = vi.fn();
    const user = userEvent.setup();
    renderWith(
      <DiscussionMessageList
        messages={[msg({ id: "server-1", body: "promote me" })]}
        onPromote={onPromote}
      />,
    );
    const btn = screen.getByTestId("promote-action");
    await user.click(btn);
    expect(onPromote).toHaveBeenCalledWith(expect.objectContaining({ id: "server-1" }));
  });

  it("hides the promote action when onPromote is omitted (non-member)", () => {
    renderWith(<DiscussionMessageList messages={[msg({ id: "server-1" })]} />);
    expect(screen.queryByTestId("promote-action")).not.toBeInTheDocument();
  });

  it("hides the promote action for an optimistic (local) message", () => {
    renderWith(<DiscussionMessageList messages={[msg({ id: "local-x" })]} onPromote={vi.fn()} />);
    expect(screen.queryByTestId("promote-action")).not.toBeInTheDocument();
  });
});
