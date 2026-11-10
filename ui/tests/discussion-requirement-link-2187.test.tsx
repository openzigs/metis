/**
 * #2187 — walkthrough run 10 (`f-j1-4b-5`): no control attached a discussion
 * to a requirement; the title was the only link. A discussion is now attached
 * to a requirement by searching the project's requirements on title, when it is
 * started and from its Settings, and the list and the thread page name it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/socket-client", () => ({ closeSocket: vi.fn(), useSocket: () => null }));

const push = vi.fn();
let routeParams: Record<string, string> = { id: "p-1" };
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => routeParams),
    useRouter: vi.fn(() => ({ push, replace: vi.fn(), prefetch: vi.fn() })),
    usePathname: vi.fn(() => "/"),
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

vi.mock("@/lib/discussions-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/discussions-api")>("@/lib/discussions-api");
  return {
    ...actual,
    listThreads: vi.fn(),
    createThread: vi.fn(),
    searchThreadRequirements: vi.fn(),
    updateThreadSettings: vi.fn(),
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// The thread page's transcript (socket, presence, composer) is covered in
// discussion-thread.test.tsx; here a stub stands in so the header is what is
// under test, with a button for the Settings anchor callback.
vi.mock("@/components/chat/discussion-thread-view", () => ({
  DiscussionThreadView: ({ onAnchorChange }: { onAnchorChange?: () => void }) => (
    <button type="button" onClick={() => onAnchorChange?.()}>
      stub-anchor-changed
    </button>
  ),
}));

import {
  createThread,
  listThreads,
  requirementHref,
  searchThreadRequirements,
  updateThreadSettings,
  type DiscussionThread,
} from "@/lib/discussions-api";
import DiscussionsListPage from "@/app/(authed)/projects/[id]/discussions/page";
import DiscussionThreadPage from "@/app/(authed)/projects/[id]/discussions/[discussionId]/page";
import { DiscussionRequirementPicker } from "@/components/chat/discussion-requirement-picker";
import { ThreadSettingsPanel } from "@/components/chat/thread-settings-panel";

const listThreadsMock = vi.mocked(listThreads);
const createThreadMock = vi.mocked(createThread);
const searchMock = vi.mocked(searchThreadRequirements);
const updateMock = vi.mocked(updateThreadSettings);

const READ_AT = {
  id: "req-1",
  title: "Track reading time with read_at timestamp",
  analysisId: "an-1",
  createdAt: "2026-10-30T00:00:00.000Z",
};
const METRICS = {
  id: "req-2",
  title: "Metrics IP allowlist restriction",
  analysisId: "an-2",
  createdAt: "2026-10-30T00:00:00.000Z",
};

function thread(over: Partial<DiscussionThread> = {}): DiscussionThread {
  return {
    id: "t-1",
    projectId: "p-1",
    title: "Last refresh timestamp",
    aiResponseMode: "on_mention",
    requirementId: null,
    analysisId: null,
    specKitFeatureId: null,
    createdById: "u-1",
    createdAt: "2026-10-30T00:00:00.000Z",
    requirement: null,
    ...over,
  };
}

function renderWith(node: React.ReactElement) {
  const Wrapper = makeWrapper({});
  return render(<Wrapper>{node}</Wrapper>);
}

beforeEach(() => {
  vi.clearAllMocks();
  routeParams = { id: "p-1" };
  searchMock.mockResolvedValue([READ_AT, METRICS]);
  listThreadsMock.mockResolvedValue([]);
});

describe("requirementHref (#2187)", () => {
  it("opens the requirement on its run's Requirements tab", () => {
    expect(requirementHref("p-1", READ_AT)).toBe(
      "/projects/p-1/analysis?analysisId=an-1&tab=requirements&requirementId=req-1",
    );
  });
});

describe("DiscussionRequirementPicker (#2187)", () => {
  it("lists the project's requirements on focus and searches on what is typed", async () => {
    const user = userEvent.setup();
    renderWith(<DiscussionRequirementPicker projectId="p-1" value={null} onChange={vi.fn()} />);
    expect(searchMock).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("About requirement (optional)"));
    const list = await screen.findByRole("list", { name: "Matching requirements" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(searchMock).toHaveBeenCalledWith("p-1", "");

    await user.type(screen.getByLabelText("About requirement (optional)"), "metrics");
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith("p-1", "metrics"));
  });

  it("hands back the requirement chosen", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWith(<DiscussionRequirementPicker projectId="p-1" value={null} onChange={onChange} />);
    await user.click(screen.getByLabelText("About requirement (optional)"));
    await user.click(await screen.findByRole("button", { name: /Metrics IP allowlist/ }));
    expect(onChange).toHaveBeenCalledWith(METRICS);
  });

  it("names the chosen requirement and removes it", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWith(<DiscussionRequirementPicker projectId="p-1" value={READ_AT} onChange={onChange} />);
    expect(screen.getByTestId("discussion-requirement-chosen")).toHaveTextContent(READ_AT.title);
    await user.click(screen.getByRole("button", { name: `Remove requirement ${READ_AT.title}` }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("says so when no title matches, and when the search fails", async () => {
    searchMock.mockResolvedValueOnce([]);
    const user = userEvent.setup();
    renderWith(<DiscussionRequirementPicker projectId="p-1" value={null} onChange={vi.fn()} />);
    await user.click(screen.getByLabelText("About requirement (optional)"));
    expect(await screen.findByText("This project has no requirements yet.")).toBeInTheDocument();

    searchMock.mockRejectedValueOnce(new Error("boom"));
    await user.type(screen.getByLabelText("About requirement (optional)"), "zz");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not load/);
  });
});

describe("starting a discussion about a requirement (#2187)", () => {
  it("sends the chosen requirement as the new thread's anchor", async () => {
    createThreadMock.mockResolvedValue(thread({ id: "t-new" }));
    const user = userEvent.setup();
    renderWith(<DiscussionsListPage />);
    await user.type(screen.getByLabelText("New discussion"), "Read timestamps");
    await user.click(screen.getByLabelText("About requirement (optional)"));
    await user.click(await screen.findByRole("button", { name: /Track reading time/ }));
    await user.click(screen.getByRole("button", { name: "Start discussion" }));
    await waitFor(() =>
      expect(createThreadMock).toHaveBeenCalledWith({
        projectId: "p-1",
        title: "Read timestamps",
        anchor: { requirementId: "req-1" },
      }),
    );
    expect(push).toHaveBeenCalledWith("/projects/p-1/discussions/t-new");
  });

  it("sends no anchor when no requirement is chosen", async () => {
    createThreadMock.mockResolvedValue(thread({ id: "t-new" }));
    const user = userEvent.setup();
    renderWith(<DiscussionsListPage />);
    await user.click(screen.getByRole("button", { name: "Start discussion" }));
    await waitFor(() => expect(createThreadMock).toHaveBeenCalledWith({ projectId: "p-1" }));
  });

  it("names each thread's requirement in the list", async () => {
    listThreadsMock.mockResolvedValue([
      thread({ requirementId: "req-1", requirement: READ_AT }),
      thread({ id: "t-2", title: "Unattached" }),
    ]);
    renderWith(<DiscussionsListPage />);
    expect(await screen.findByText(`About: ${READ_AT.title}`)).toBeInTheDocument();
    expect(screen.getAllByText(/^About: /)).toHaveLength(1);
  });
});

describe("the thread page names its requirement (#2187)", () => {
  beforeEach(() => {
    routeParams = { id: "p-1", discussionId: "t-1" };
  });

  it("links to the requirement by title", async () => {
    listThreadsMock.mockResolvedValue([thread({ requirementId: "req-1", requirement: READ_AT })]);
    renderWith(<DiscussionThreadPage />);
    const link = await screen.findByRole("link", { name: READ_AT.title });
    expect(link).toHaveAttribute("href", requirementHref("p-1", READ_AT));
    expect(screen.getByTestId("discussion-requirement")).toHaveTextContent("About requirement:");
  });

  it("shows no requirement line for an unattached thread", async () => {
    listThreadsMock.mockResolvedValue([thread()]);
    renderWith(<DiscussionThreadPage />);
    await screen.findByRole("heading", { name: "Last refresh timestamp" });
    expect(screen.queryByTestId("discussion-requirement")).not.toBeInTheDocument();
  });

  it("re-reads the thread after Settings attaches it to something", async () => {
    listThreadsMock.mockResolvedValue([thread()]);
    const user = userEvent.setup();
    renderWith(<DiscussionThreadPage />);
    await screen.findByRole("heading", { name: "Last refresh timestamp" });
    const before = listThreadsMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "stub-anchor-changed" }));
    await waitFor(() => expect(listThreadsMock.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("ThreadSettingsPanel attaches a requirement by title (#2187)", () => {
  it("PATCHes the chosen requirement as the anchor", async () => {
    updateMock.mockResolvedValue(thread({ requirementId: "req-2" }));
    const onAnchorChange = vi.fn();
    const user = userEvent.setup();
    renderWith(
      <ThreadSettingsPanel
        threadId="t-1"
        aiResponseMode="on_mention"
        projectId="p-1"
        onAnchorChange={onAnchorChange}
      />,
    );
    // No paste-an-id box for a requirement once the project is known.
    expect(screen.queryByPlaceholderText("Paste the id to anchor to")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Requirement"));
    await user.click(await screen.findByRole("button", { name: /Metrics IP allowlist/ }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith("t-1", { anchor: { requirementId: "req-2" } }),
    );
    expect(onAnchorChange).toHaveBeenCalledWith({ requirementId: "req-2" });
  });

  it("keeps the id box for the other anchor kinds", async () => {
    const user = userEvent.setup();
    renderWith(<ThreadSettingsPanel threadId="t-1" aiResponseMode="off" projectId="p-1" />);
    await user.selectOptions(screen.getByLabelText("Anchor type"), "analysisId");
    expect(screen.getByPlaceholderText("Paste the id to anchor to")).toBeInTheDocument();
  });
});
