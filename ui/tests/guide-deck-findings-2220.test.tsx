/**
 * #2220 — the guide-deck walkthrough's raw labels, review diff JSON and layout
 * findings. Each block reads the surface a user sees.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

let socket: FakeSocket;
vi.mock("@/lib/socket-client", () => ({
  closeSocket: vi.fn(),
  useSocket: () => socket,
}));

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: (...args: unknown[]) => mockApiFetch(...args) };
});

import { isGeneratedControlId } from "@metis/shared";
import { NotificationsDrawer } from "@/components/notifications/notifications-drawer";
import {
  _resetNotificationStoreForTests,
  formatNotificationTime,
  notificationKindLabel,
} from "@/lib/notifications";
import { aiResponseModeSummary } from "@/lib/discussions-api";
import {
  isHiddenRequirementLabel,
  listChange,
  requirementFieldLabel,
  requirementListItems,
  snapshotDiffText,
} from "@/lib/requirement-fields";
import { VersionDiff } from "@/components/reviews/VersionDiff";
import { AcceptanceCriteriaList } from "@/components/analysis/AcceptanceCriteriaList";
import { ControlId } from "@/components/governing/control-id";
import { missingUploadFields } from "@/components/governing/governing-upload-dialog";

describe("notifications drawer (#2220)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetNotificationStoreForTests();
    socket = createFakeSocket();
  });

  it("names the type in words and dates an item from another day", async () => {
    mockApiFetch.mockResolvedValue({
      notifications: [
        {
          id: "n-approved",
          type: "review_approved",
          title: "Review approved",
          message: "Your review was approved.",
          href: null,
          read: false,
          createdAt: "2025-03-04T15:30:00.000Z",
        },
      ],
      unreadCount: 1,
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("notifications-bell"));
    const row = await screen.findByTestId("notification-n-approved");
    expect(within(row).getByTestId("notification-kind")).toHaveTextContent("Review approved");
    expect(row).not.toHaveTextContent("review_approved");
    const time = row.querySelector("time")!;
    expect(time).toHaveAttribute("dateTime", "2025-03-04T15:30:00.000Z");
    expect(time.textContent).toMatch(/2025/);
  });

  it("labels every known type, words out an unknown one, and falls back on the level", () => {
    expect(notificationKindLabel("review_item_changed", "warn")).toBe(
      "Approved requirement edited",
    );
    expect(notificationKindLabel("job_failed", "warn")).toBe("Job failed");
    expect(notificationKindLabel("some_new_kind", "info")).toBe("Some new kind");
    expect(notificationKindLabel(undefined, "warn")).toBe("Warning");
    expect(notificationKindLabel("  ", "error")).toBe("Error");
    expect(notificationKindLabel(undefined, "info")).toBe("Notice");
  });

  it("says Today for today's item and gives the date otherwise", () => {
    const now = new Date(2026, 10, 14, 18, 0);
    expect(formatNotificationTime(new Date(2026, 10, 14, 9, 5).toISOString(), now)).toMatch(
      /^Today, /,
    );
    const lastWeek = formatNotificationTime(new Date(2026, 10, 7, 9, 5).toISOString(), now);
    expect(lastWeek).not.toMatch(/Today/);
    expect(lastWeek).toMatch(/7/);
    expect(lastWeek).not.toMatch(/2026/);
    expect(formatNotificationTime(new Date(2025, 0, 2).toISOString(), now)).toMatch(/2025/);
    expect(formatNotificationTime("not a date", now)).toBe("");
  });
});

describe("discussion row AI mode (#2220)", () => {
  it("says the mode in words, never the raw value", () => {
    expect(aiResponseModeSummary("on_mention")).toBe("AI replies when @AI is mentioned");
    expect(aiResponseModeSummary("off")).toBe("AI off");
    expect(aiResponseModeSummary("auto")).toBe("AI replies automatically");
    expect(aiResponseModeSummary("something_else")).toBeNull();
    expect(aiResponseModeSummary(undefined)).toBeNull();
  });
});

describe("requirement fields for readers (#2220)", () => {
  it("names fields, known or not", () => {
    expect(requirementFieldLabel("acceptanceCriteria")).toBe("Acceptance criteria");
    expect(requirementFieldLabel("storyPoints")).toBe("Story points");
    expect(requirementFieldLabel("someNewField")).toBe("Some new field");
  });

  it("reads a list field's JSON, drops hidden labels, and leaves other fields alone", () => {
    expect(requirementListItems("acceptanceCriteria", '["Shows \\"time\\"", " ", "B"]')).toEqual([
      'Shows "time"',
      "B",
    ]);
    expect(requirementListItems("labels", '["ui","finding:cmwb1","review:x"]')).toEqual(["ui"]);
    expect(requirementListItems("labels", ["a", 2])).toEqual(["a", "2"]);
    expect(requirementListItems("acceptanceCriteria", "not json")).toEqual(["not json"]);
    expect(requirementListItems("acceptanceCriteria", null)).toEqual([]);
    expect(requirementListItems("title", "x")).toBeNull();
    expect(isHiddenRequirementLabel("finding:1")).toBe(true);
    expect(isHiddenRequirementLabel("feature")).toBe(false);
  });

  it("finds what a list change removed and added", () => {
    expect(listChange(["a", "b"], ["b", "c"])).toEqual({
      removed: ["a"],
      added: ["c"],
      reordered: false,
    });
  });

  it("counts a duplicated item, and reports a pure reorder", () => {
    expect(listChange(["a"], ["a", "a"])).toEqual({ removed: [], added: ["a"], reordered: false });
    expect(listChange(["a", "a", "b"], ["a", "b"])).toEqual({
      removed: ["a"],
      added: [],
      reordered: false,
    });
    expect(listChange(["a", "b"], ["b", "a"])).toEqual({ removed: [], added: [], reordered: true });
    expect(listChange(["a", "b"], ["a", "b"])).toEqual({
      removed: [],
      added: [],
      reordered: false,
    });
  });

  it("writes a snapshot one criterion per line, under readable names", () => {
    const text = snapshotDiffText(
      {
        title: "T",
        storyPoints: null,
        acceptanceCriteria: '["One","Two"]',
        labels: '["finding:x"]',
      },
      ["title", "storyPoints", "acceptanceCriteria", "labels"],
    );
    expect(text).toBe(
      [
        "Title: T",
        "Story points: —",
        "Acceptance criteria:",
        "  • One",
        "  • Two",
        "Labels: —",
      ].join("\n"),
    );
  });
});

describe("VersionDiff — list fields (#2220)", () => {
  it("shows a criteria change as the criteria removed and added, under a readable name", () => {
    render(
      <VersionDiff
        changedFields={{
          acceptanceCriteria: { from: '["Kept","Old \\"one\\""]', to: '["Kept","New one"]' },
        }}
      />,
    );
    const row = screen.getByTestId("diff-field-acceptanceCriteria");
    expect(row.querySelector("dt")).toHaveTextContent("Acceptance criteria");
    expect(within(row).getByTestId("diff-from")).toHaveTextContent('Old "one"');
    expect(within(row).getByTestId("diff-to")).toHaveTextContent("New one");
    expect(row).not.toHaveTextContent("Kept");
    expect(row).not.toHaveTextContent("[");
    expect(row).not.toHaveTextContent("acceptanceCriteria");
  });

  it("leaves out a change only to hidden finding labels", () => {
    render(
      <VersionDiff
        changedFields={{
          labels: { from: '["ui"]', to: '["ui","finding:cmwb123"]' },
          title: { from: "A", to: "B" },
        }}
      />,
    );
    expect(screen.queryByTestId("diff-field-labels")).toBeNull();
    expect(screen.getByTestId("diff-field-title")).toHaveTextContent("Title");
  });

  it("shows a reorder of the criteria as the order before and after", () => {
    render(
      <VersionDiff
        changedFields={{
          acceptanceCriteria: { from: '["First","Second"]', to: '["Second","First"]' },
        }}
      />,
    );
    const row = screen.getByTestId("diff-field-acceptanceCriteria");
    expect(row).toHaveTextContent("Order changed");
    expect(within(row).getByTestId("diff-from")).toHaveTextContent("1. First 2. Second");
    expect(within(row).getByTestId("diff-to")).toHaveTextContent("1. Second 2. First");
  });

  it("shows a duplicated criterion as added", () => {
    render(
      <VersionDiff
        changedFields={{ acceptanceCriteria: { from: '["Same"]', to: '["Same","Same"]' } }}
      />,
    );
    const row = screen.getByTestId("diff-field-acceptanceCriteria");
    expect(within(row).getByTestId("diff-to")).toHaveTextContent("Same");
    expect(within(row).queryByTestId("diff-from")).toBeNull();
  });

  it("with nothing visible left, says no field changed", () => {
    render(<VersionDiff changedFields={{ labels: { from: "[]", to: '["finding:1"]' } }} />);
    expect(screen.getByText(/No field changes recorded/i)).toBeInTheDocument();
  });
});

describe("acceptance criteria with backticks (#2220)", () => {
  it("renders a `backticked` identifier as code, without the backticks", () => {
    render(<AcceptanceCriteriaList criteria={["The `reading_time` field is shown"]} />);
    const list = screen.getByTestId("acceptance-criteria");
    expect(list.querySelector("code")).toHaveTextContent("reading_time");
    expect(list).not.toHaveTextContent("`");
  });
});

describe("generated control ids (#2220)", () => {
  it("marks an id METIS numbered, and not the policy's own", () => {
    expect(isGeneratedControlId("METIS-002")).toBe(true);
    expect(isGeneratedControlId("AC-2")).toBe(false);
    expect(isGeneratedControlId("METIS-AB")).toBe(false);
    const { rerender } = render(<ControlId controlId="METIS-002" />);
    expect(screen.getByTestId("generated-control-id")).toHaveTextContent("numbered by METIS");
    rerender(<ControlId controlId="AC-2" />);
    expect(screen.queryByTestId("generated-control-id")).toBeNull();
    expect(screen.getByText("AC-2")).toBeInTheDocument();
  });
});

describe("governing upload — what is missing (#2220)", () => {
  const file = new File(["x"], "p.md", { type: "text/markdown" });
  const full = {
    file,
    fileError: null,
    title: "Policy",
    revisionLabel: "v1",
    effectiveDate: "2026-01-01",
    isRevision: false,
  };

  it("lists each missing field in form order, and nothing once complete", () => {
    expect(missingUploadFields(full)).toEqual([]);
    expect(
      missingUploadFields({
        ...full,
        file: null,
        title: " ",
        revisionLabel: "",
        effectiveDate: "",
      }),
    ).toEqual(["a file", "a title", "a revision label", "an effective date"]);
    expect(missingUploadFields({ ...full, fileError: "too big" })).toEqual(["a file"]);
    // A revision has no title of its own.
    expect(missingUploadFields({ ...full, title: "", isRevision: true })).toEqual([]);
  });
});
