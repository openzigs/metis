/**
 * Issue #363 — repository files are listed by file path and repository label,
 * never by their internal `connector:repo:<connectorId>:<path>` key.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { formatDocumentName } from "@/lib/document-name";
import { DocumentName } from "@/components/projects/document-name";

const KEY = "connector:repo:cmumwycfx002j2c9kp7kpu2tg:src/vitest.config.ts";
const NAMES = { cmumwycfx002j2c9kp7kpu2tg: "metis" };

describe("formatDocumentName", () => {
  it("shows a repository file as its path over the repository's name", () => {
    expect(formatDocumentName(KEY, NAMES)).toEqual({
      primary: "src/vitest.config.ts",
      secondary: "metis",
      rawId: KEY,
      kind: "repo",
    });
  });

  it("keeps the whole path, not just the basename", () => {
    const name = formatDocumentName("connector:repo:c1:a/b/c/File.java", { c1: "wms" });
    expect(name.primary).toBe("a/b/c/File.java");
  });

  it("falls back to a short connector token while the repository name is unknown", () => {
    const name = formatDocumentName(KEY);
    expect(name.secondary).toBe("kpu2tg");
    expect(name.primary).toBe("src/vitest.config.ts");
  });

  it("never puts the internal key in a visible field", () => {
    const name = formatDocumentName(KEY, NAMES);
    expect(`${name.primary} ${name.secondary}`).not.toContain("connector:repo:");
  });

  it("passes an uploaded filename through unchanged", () => {
    expect(formatDocumentName("Spec v2.docx", NAMES)).toEqual({
      primary: "Spec v2.docx",
      rawId: "Spec v2.docx",
      kind: "file",
    });
  });

  it("labels a generated document readably", () => {
    const name = formatDocumentName("generated-doc-cmqpizckr017z8ewh2unm1418.md");
    expect(name).toMatchObject({ primary: "Generated document", kind: "generated" });
  });
});

describe("<DocumentName />", () => {
  it("renders path and repository, with the key only in the tooltip", () => {
    const { container } = render(<DocumentName filename={KEY} repoNames={NAMES} />);
    expect(screen.getByText("src/vitest.config.ts")).toBeInTheDocument();
    expect(screen.getByText("metis")).toBeInTheDocument();
    expect(container.textContent).not.toContain("connector:repo:");
    expect(container.firstElementChild).toHaveAttribute("title", KEY);
    expect(container.firstElementChild).toHaveAttribute("data-kind", "repo");
  });

  it("renders a plain upload on one line", () => {
    const { container } = render(<DocumentName filename="notes.md" className="font-medium" />);
    expect(container.textContent).toBe("notes.md");
    expect(container.firstElementChild).toHaveClass("font-medium");
  });
});
