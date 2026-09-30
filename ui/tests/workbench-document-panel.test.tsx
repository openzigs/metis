/**
 * Issue #32 — the Workbench Documents panel: filter as you type, uploads
 * grouped apart, repository files as a collapsed tree that stays small with
 * 5,000 files, and no internal id in any label.
 *
 * #526 — the rows are virtualised: jsdom has no layout, so the virtualiser is
 * the stub in `virtualizer-stub.ts`, which windows rows by their estimated size.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocumentRow } from "@/lib/projects-api";
import {
  DocumentPanel,
  SEARCH_RENDER_LIMIT,
  estimateRowSize,
} from "@/components/workbench/document-panel";
import { toPanelEntries, type PanelRow } from "@/lib/workbench-document-tree";
import { virtualWindow } from "./virtualizer-stub";

vi.mock("@tanstack/react-virtual", async () => (await import("./virtualizer-stub")).module);

afterEach(() => {
  virtualWindow.scrollTop = 0;
  virtualWindow.height = Infinity;
});

const CONN = "cmexample0000000000acmerp";
const names = { [CONN]: "wms-core" };

function doc(id: string, filename: string): DocumentRow {
  return {
    id,
    projectId: "p1",
    filename,
    // #474 — as the writer stores it: the panel classifies on this, not the filename.
    source: filename.startsWith("connector:repo:")
      ? "repo"
      : filename.startsWith("connector:db:")
        ? "db"
        : filename.startsWith("jira:")
          ? "jira"
          : "upload",
    mimeType: "text/plain",
    sizeBytes: 1,
    status: "ready",
    chunkCount: 1,
    uploadedAt: "2026-09-01T10:00:00Z",
  };
}
const repo = (id: string, path: string) => doc(id, `connector:repo:${CONN}:${path}`);

const docs = [
  repo("r1", "src/billing/Invoice.ts"),
  repo("r2", "tests/invoice.spec.ts"),
  repo("r3", "README.md"),
  doc("u1", "Requirements.docx"),
];

interface PanelOptions {
  documents?: DocumentRow[];
  repoNames?: Record<string, string>;
  attachedIds?: string[];
  total?: number;
}

/** The page parses the list once (`toPanelEntries`) and hands the panel the entries. */
function renderPanel({
  documents = docs,
  repoNames = names,
  attachedIds = [],
  total,
}: PanelOptions = {}) {
  const props = {
    entries: toPanelEntries(documents, repoNames),
    total,
    attachedIds: new Set(attachedIds),
    onAttach: vi.fn(),
    onDetach: vi.fn(),
  };
  const view = render(<DocumentPanel {...props} />);
  return { ...props, ...view };
}

/** The mounted rows of one group (#526: the panel is one flat, virtualised list). */
const groupRows = (group: "uploads" | "repos" | "sources") => [
  ...document.querySelectorAll<HTMLElement>(`li[data-group="${group}"]`),
];

describe("DocumentPanel", () => {
  it("lists uploads in their own group ahead of the repositories", () => {
    renderPanel();
    const uploads = screen.getByTestId("workbench-uploads");
    const repos = screen.getByTestId("workbench-repos");
    expect(uploads).toHaveTextContent("Uploaded");
    const uploadText = groupRows("uploads")
      .map((li) => li.textContent)
      .join(" ");
    expect(uploadText).toContain("Requirements.docx");
    expect(uploadText).not.toContain("README.md");
    // Uploads come first in the panel.
    expect(uploads.compareDocumentPosition(repos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("starts each repository collapsed, and opens folders on click", async () => {
    const user = userEvent.setup();
    renderPanel();
    const root = screen.getByRole("button", { name: /wms-core/ });
    expect(root).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("workbench-doc-r3")).toBeNull();

    await user.click(root);
    expect(root).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("workbench-doc-r3")).toHaveTextContent("README.md");
    // Nested files stay hidden until their folder opens.
    expect(screen.queryByTestId("workbench-doc-r1")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^▸?\s*src/ }));
    await user.click(screen.getByRole("button", { name: /billing/ }));
    expect(screen.getByTestId("workbench-doc-r1")).toHaveTextContent("Invoice.ts");

    // And closes again.
    await user.click(root);
    expect(screen.queryByTestId("workbench-doc-r1")).toBeNull();
  });

  it("shows the full path on hover and no internal id anywhere", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel({ repoNames: {} });
    await user.type(screen.getByTestId("workbench-doc-filter"), "invoice");
    const row = screen.getByTestId("workbench-doc-r1");
    expect(row.querySelector('[title="Unnamed repository/src/billing/Invoice.ts"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/acmerp|connector:repo/);
    expect(container.innerHTML).not.toContain("connector:repo");
  });

  it("filters by name as you type and opens the matching folders", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByTestId("workbench-doc-filter"), "INVOICE");
    expect(screen.getByTestId("workbench-doc-r1")).toBeInTheDocument();
    expect(screen.getByTestId("workbench-doc-r2")).toBeInTheDocument();
    expect(screen.queryByTestId("workbench-doc-r3")).toBeNull();
    expect(screen.queryByTestId("workbench-uploads")).toBeNull();
  });

  it("filters by path", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByTestId("workbench-doc-filter"), "tests/");
    expect(screen.getByTestId("workbench-doc-r2")).toBeInTheDocument();
    expect(screen.queryByTestId("workbench-doc-r1")).toBeNull();
  });

  it("says when nothing matches, and restores the tree when cleared", async () => {
    const user = userEvent.setup();
    renderPanel();
    const box = screen.getByTestId("workbench-doc-filter");
    await user.type(box, "zzz");
    expect(screen.getByRole("status")).toHaveTextContent("No documents match “zzz”");
    await user.clear(box);
    expect(screen.getByRole("button", { name: /wms-core/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByTestId("workbench-uploads")).toBeInTheDocument();
  });

  it("attaches and detaches through the row's button", async () => {
    const user = userEvent.setup();
    const props = renderPanel({ attachedIds: ["u1"] });
    const attached = screen.getByTestId("workbench-doc-attach-u1");
    expect(attached).toHaveTextContent("Attached");
    await user.click(attached);
    expect(props.onDetach).toHaveBeenCalledWith("u1");

    await user.click(screen.getByRole("button", { name: /wms-core/ }));
    await user.click(screen.getByTestId("workbench-doc-attach-r3"));
    expect(props.onAttach).toHaveBeenCalledWith("r3");
  });

  it("renders a handful of rows for 5,000 repository files", () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      repo(`m${i}`, `pkg${i % 10}/sub${i % 7}/file${i}.ts`),
    );
    renderPanel({ documents: many });
    // The group heading and one repository row, nothing beneath it, until it is opened.
    expect(document.body.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /wms-core/ })).toHaveTextContent("5000");
  });

  it("caps rendered matches and says how many more there are", () => {
    const many = Array.from({ length: 1000 }, (_, i) => repo(`m${i}`, `src/file${i}.ts`));
    renderPanel({ documents: many });
    fireEvent.change(screen.getByTestId("workbench-doc-filter"), { target: { value: "file" } });
    expect(screen.getAllByTestId(/^workbench-doc-m\d+$/)).toHaveLength(SEARCH_RENDER_LIMIT);
    expect(screen.getByRole("status")).toHaveTextContent(
      `Showing ${SEARCH_RENDER_LIMIT} of 1000 matches`,
    );
  });

  it("keeps connector documents out of Uploaded, under Other sources (review of #436)", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel({
      documents: [
        doc("u1", "Requirements.docx"),
        doc("d1", "connector:db:cmexampledbconn0000dbzz99:public.orders.md"),
        doc("j1", "jira:WMS-42"),
      ],
      repoNames: {},
    });
    // The heading and the one upload.
    expect(groupRows("uploads")).toHaveLength(2);
    expect(screen.getByTestId("workbench-sources")).toHaveTextContent("Other sources");
    await user.click(screen.getByRole("button", { name: /Database schema/ }));
    const d1 = screen.getByTestId("workbench-doc-d1");
    expect(d1).toHaveTextContent("public.orders");
    expect(d1.closest("li")).toHaveAttribute("data-group", "sources");
    expect(container.textContent).not.toMatch(/dbzz99|connector:db|jira:/);
  });

  it("disables folder toggles while filtering, when every match's folder is open", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByTestId("workbench-doc-filter"), "invoice");
    const root = screen.getByRole("button", { name: /wms-core/ });
    expect(root).toBeDisabled();
    await user.clear(screen.getByTestId("workbench-doc-filter"));
    expect(root).toBeEnabled();
  });

  it("does not claim a cut-short list when a row went missing under the ceiling", () => {
    // One more in `total` than loaded — e.g. a delete during the paged read.
    renderPanel({ total: docs.length + 1 });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says when the project holds more documents than were loaded", () => {
    renderPanel({ total: 12000 });
    expect(screen.getByRole("status")).toHaveTextContent("Showing the first 4 of 12000 documents");
  });

  it("says nothing about unloaded documents when all were loaded", () => {
    renderPanel({ total: docs.length });
    expect(screen.queryByRole("status")).toBeNull();
  });

  // #526 — an OPEN folder of thousands of files mounts only the rows in view.
  it("mounts only the rows in view when a folder of 5,000 files is open", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 5000 }, (_, i) => repo(`m${i}`, `file${i}.ts`));
    virtualWindow.height = 320;
    renderPanel({ documents: many });
    await user.click(screen.getByRole("button", { name: /wms-core/ }));

    const mounted = document.body.querySelectorAll("li");
    // A 320px window over 28px + 32px rows: ten or eleven rows, not 5,002.
    expect(mounted.length).toBeGreaterThan(5);
    expect(mounted.length).toBeLessThan(15);
    // The list is as tall as every row, so the scrollbar spans all 5,000 files.
    expect(screen.getByRole("list", { name: "Documents" })).toHaveStyle({
      height: `${28 + 32 + 5000 * 32}px`,
    });
    // Each mounted row is placed at its own offset.
    expect(mounted[1]).toHaveStyle({ transform: "translateY(28px)" });
  });

  it("mounts the rows further down once scrolled there", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 5000 }, (_, i) => repo(`m${i}`, `file${i}.ts`));
    virtualWindow.height = 320;
    const panel = renderPanel({ documents: many });
    await user.click(screen.getByRole("button", { name: /wms-core/ }));
    expect(screen.getByTestId("workbench-doc-m0")).toBeInTheDocument();
    // Scroll to the 4,001st file.
    virtualWindow.scrollTop = 28 + 32 + 4000 * 32;
    panel.rerender(
      <DocumentPanel
        entries={panel.entries}
        attachedIds={panel.attachedIds}
        onAttach={panel.onAttach}
        onDetach={panel.onDetach}
      />,
    );
    const ids = screen.getAllByTestId(/^workbench-doc-m\d+$/).map((el) => el.dataset.testid);
    expect(ids.length).toBeLessThan(15);
    // Sorted by name with numeric collation: the 4,001st file is file4000.ts.
    expect(ids[0]).toBe("workbench-doc-m4000");
    expect(screen.queryByTestId("workbench-doc-m0")).toBeNull();
  });

  it("indents a row by its depth in the tree", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByTestId("workbench-doc-filter"), "invoice");
    // wms-core / src / billing / Invoice.ts
    expect(screen.getByTestId("workbench-doc-r1")).toHaveStyle({ paddingLeft: "36px" });
  });
});

describe("estimateRowSize", () => {
  const [entry] = toPanelEntries([doc("u1", "a.md")]);
  it("sizes headings, folders and files, and a file with a second line taller", () => {
    expect(
      estimateRowSize({ type: "heading", key: "h", group: "uploads", label: "Uploaded" }),
    ).toBe(28);
    const folder: PanelRow = {
      type: "folder",
      key: "f",
      group: "repos",
      depth: 0,
      folder: { key: "f", name: "src", folders: [], files: [], fileCount: 0 },
    };
    expect(estimateRowSize(folder)).toBe(32);
    expect(estimateRowSize({ type: "file", key: "x", group: "uploads", depth: 0, entry })).toBe(32);
    expect(
      estimateRowSize({
        type: "file",
        key: "y",
        group: "uploads",
        depth: 0,
        entry: { ...entry, secondary: "1/2/2026" },
      }),
    ).toBe(48);
  });
});
