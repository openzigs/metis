/**
 * #2218 — review follow-ups on the discussion requirement picker (#2217):
 *
 * - the active option was an index: an arrow key pressed during the 250 ms
 *   debounce, then results for the new term, left the same index highlighted
 *   over a different requirement, and Enter picked one the user never moved
 *   to. It is now the option's id, so an option that left the results is no
 *   longer active;
 * - the sr-only status was mounted together with the list, so the first count
 *   was never announced. One status region now lives as long as the search box.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/discussions-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/discussions-api")>("@/lib/discussions-api");
  return { ...actual, searchThreadRequirements: vi.fn() };
});

import { searchThreadRequirements } from "@/lib/discussions-api";
import { DiscussionRequirementPicker } from "@/components/chat/discussion-requirement-picker";

const searchMock = vi.mocked(searchThreadRequirements);

const req = (id: string, title: string) => ({
  id,
  title,
  analysisId: "an-1",
  createdAt: "2026-10-30T00:00:00.000Z",
});
const FEEDS = req("req-a", "Refresh feeds on a schedule");
const METRICS = req("req-b", "Metrics IP allowlist restriction");
const EXPORT = req("req-c", "Export entries as OPML");

const LABEL = "About requirement (optional)";

function renderPicker() {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const Wrapper = makeWrapper({});
  render(
    <Wrapper>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <DiscussionRequirementPicker projectId="p-1" value={null} onChange={onChange} />
      </form>
    </Wrapper>,
  );
  return { box: screen.getByRole("combobox", { name: LABEL }), onChange, onSubmit };
}

/** Answers the blank term with FEEDS, METRICS and `term` with `rows`. */
function answer(term: string, rows: (typeof FEEDS)[]) {
  searchMock.mockImplementation(async (_projectId, q) => (q === term ? rows : [FEEDS, METRICS]));
}

beforeEach(() => {
  vi.clearAllMocks();
  searchMock.mockResolvedValue([FEEDS, METRICS]);
});

describe("the picker's active option is an id, not an index (#2218)", () => {
  it("does not put a requirement the user never moved to under Enter", async () => {
    answer("x", [EXPORT]);
    const user = userEvent.setup();
    const { box, onChange, onSubmit } = renderPicker();
    await user.click(box);
    await screen.findByRole("option", { name: new RegExp(FEEDS.title) });

    // Typed, then ArrowDown inside the debounce: the old first option is active.
    await user.type(box, "x");
    await user.keyboard("{ArrowDown}");
    expect(box.getAttribute("aria-activedescendant")).toContain(FEEDS.id);

    // The new term's results arrive: that option is gone, so none is active.
    await screen.findByRole("option", { name: new RegExp(EXPORT.title) });
    expect(box).not.toHaveAttribute("aria-activedescendant");
    expect(screen.getByRole("option", { name: new RegExp(EXPORT.title) })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps the option the user moved to active when it moves in the new results", async () => {
    answer("x", [METRICS, EXPORT]);
    const user = userEvent.setup();
    const { box, onChange } = renderPicker();
    await user.click(box);
    await screen.findByRole("option", { name: new RegExp(FEEDS.title) });

    await user.type(box, "x");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(box.getAttribute("aria-activedescendant")).toContain(METRICS.id);

    // METRICS was second and is now first; the second is EXPORT.
    await screen.findByRole("option", { name: new RegExp(EXPORT.title) });
    expect(box.getAttribute("aria-activedescendant")).toContain(METRICS.id);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(METRICS);
  });

  it("moves on from the option in its new place", async () => {
    answer("x", [METRICS, EXPORT]);
    const user = userEvent.setup();
    const { box, onChange } = renderPicker();
    await user.click(box);
    await screen.findByRole("option", { name: new RegExp(FEEDS.title) });

    await user.type(box, "x");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await screen.findByRole("option", { name: new RegExp(EXPORT.title) });
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith(EXPORT);
  });
});

describe("the picker's status region is mounted with the search box (#2218)", () => {
  it("announces the first count in the region that was there before the list", async () => {
    const user = userEvent.setup();
    const { box } = renderPicker();
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("");

    await user.click(box);
    await screen.findByRole("listbox", { name: "Matching requirements" });
    await waitFor(() => expect(region).toHaveTextContent("2 matching requirements"));
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveClass("sr-only");
  });

  it("shows the empty state in that same region", async () => {
    searchMock.mockResolvedValue([]);
    const user = userEvent.setup();
    const { box } = renderPicker();
    const region = screen.getByRole("status");

    await user.click(box);
    await waitFor(() => expect(region).toHaveTextContent("This project has no requirements yet."));
    expect(region).not.toHaveClass("sr-only");
    expect(screen.getByRole("status")).toBe(region);
  });

  it("goes quiet once the list is closed", async () => {
    const user = userEvent.setup();
    const { box } = renderPicker();
    await user.click(box);
    await screen.findByRole("listbox", { name: "Matching requirements" });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});
