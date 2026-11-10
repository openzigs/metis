/**
 * #2209 — review follow-ups on the discussion requirement picker (#2207):
 *
 * - with `keepPreviousData` the picker said "No requirement title contains …"
 *   (or "This project has no requirements yet.") for a term the server had not
 *   answered; it now says it is searching until it has, and marks a refetch
 *   behind the list on screen as busy;
 * - the popup was a list of buttons under `role="combobox"`; it is now a
 *   listbox of options driven from the search box with the arrow keys
 *   (`aria-activedescendant`), Enter and Escape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

const LABEL = "About requirement (optional)";
const never = () => new Promise<never>(() => undefined);

function renderPicker(onChange = vi.fn(), onSubmit = vi.fn()) {
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

beforeEach(() => {
  vi.clearAllMocks();
  searchMock.mockResolvedValue([READ_AT, METRICS]);
});

describe("the picker's empty state waits for the server (#2209)", () => {
  it("says it is searching, not that nothing matches, while the next term loads", async () => {
    searchMock.mockResolvedValueOnce([]);
    const user = userEvent.setup();
    const { box } = renderPicker();
    await user.click(box);
    expect(await screen.findByText("This project has no requirements yet.")).toBeInTheDocument();

    searchMock.mockImplementation(never);
    await user.type(box, "met");
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith("p-1", "met"));
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");
    expect(screen.queryByText(/No requirement title contains/)).not.toBeInTheDocument();
    expect(screen.queryByText("This project has no requirements yet.")).not.toBeInTheDocument();
  });

  it("says nothing matches once the server has answered the term", async () => {
    const user = userEvent.setup();
    const { box } = renderPicker();
    await user.click(box);
    await screen.findByRole("listbox", { name: "Matching requirements" });
    searchMock.mockResolvedValue([]);
    await user.type(box, "zz");
    expect(await screen.findByText('No requirement title contains "zz".')).toBeInTheDocument();
  });

  it("marks the list on screen busy while the next term is fetched", async () => {
    const user = userEvent.setup();
    const { box } = renderPicker();
    await user.click(box);
    const list = await screen.findByRole("listbox", { name: "Matching requirements" });
    expect(list).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("status")).toHaveTextContent("2 matching requirements");

    let answer: (rows: (typeof METRICS)[]) => void = () => undefined;
    searchMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await user.type(box, "metrics");
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith("p-1", "metrics"));
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Updating matches…");

    answer([METRICS]);
    await waitFor(() => expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("status")).toHaveTextContent("1 matching requirement");
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
  });
});

describe("the picker's listbox keyboard model (#2209)", () => {
  it("is a listbox of options, none active until an arrow key is pressed", async () => {
    const user = userEvent.setup();
    const { box } = renderPicker();
    await user.click(box);
    const list = await screen.findByRole("listbox", { name: "Matching requirements" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining(READ_AT.title),
      expect.stringContaining(METRICS.title),
    ]);
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
    expect(box).not.toHaveAttribute("aria-activedescendant");
    expect(options.every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("moves the active option with the arrow keys, wrapping at either end", async () => {
    const user = userEvent.setup();
    const { box } = renderPicker();
    await user.click(box);
    const list = await screen.findByRole("listbox", { name: "Matching requirements" });
    const [first, second] = within(list).getAllByRole("option");
    const active = () => box.getAttribute("aria-activedescendant");

    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(first.id);
    expect(first).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(second.id);
    expect(first).toHaveAttribute("aria-selected", "false");
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(first.id);
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe(second.id);
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe(first.id);
  });

  it("picks the active option on Enter, without submitting the form", async () => {
    const user = userEvent.setup();
    const { box, onChange, onSubmit } = renderPicker();
    await user.click(box);
    await screen.findByRole("listbox", { name: "Matching requirements" });
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith(METRICS);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves Enter to the form while no option is active", async () => {
    const user = userEvent.setup();
    const { box, onChange, onSubmit } = renderPicker();
    await user.click(box);
    await screen.findByRole("listbox", { name: "Matching requirements" });
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes on Escape and reopens on ArrowDown", async () => {
    const user = userEvent.setup();
    const { box } = renderPicker();
    await user.click(box);
    await screen.findByRole("listbox", { name: "Matching requirements" });
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(box).not.toHaveAttribute("aria-activedescendant");

    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(box).not.toHaveAttribute("aria-activedescendant");
  });

  it("forgets the active option when the term changes", async () => {
    const user = userEvent.setup();
    const { box } = renderPicker();
    await user.click(box);
    await screen.findByRole("listbox", { name: "Matching requirements" });
    await user.keyboard("{ArrowDown}");
    expect(box).toHaveAttribute("aria-activedescendant");
    await user.type(box, "m");
    expect(box).not.toHaveAttribute("aria-activedescendant");
  });
});
