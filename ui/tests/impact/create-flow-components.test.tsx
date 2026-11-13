import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DocumentSourceSelector } from "@/components/impact/document-source-selector";
import { RunImpactAnalysisButton } from "@/components/impact/run-impact-analysis-button";

describe("DocumentSourceSelector", () => {
  const base = {
    text: "",
    onTextChange: vi.fn(),
    documents: [],
    documentId: null as string | null,
    onDocumentChange: vi.fn(),
  };

  it("shows textarea in text mode and propagates changes", () => {
    const onTextChange = vi.fn();
    render(
      <DocumentSourceSelector
        {...base}
        mode="text"
        onModeChange={() => {}}
        onTextChange={onTextChange}
      />,
    );
    fireEvent.change(screen.getByTestId("source-text-input"), { target: { value: "hi" } });
    expect(onTextChange).toHaveBeenCalledWith("hi");
  });

  it("switches mode via radios", () => {
    const onModeChange = vi.fn();
    render(<DocumentSourceSelector {...base} mode="text" onModeChange={onModeChange} />);
    fireEvent.click(screen.getByTestId("source-mode-document"));
    expect(onModeChange).toHaveBeenCalledWith("document");
  });

  it("renders document loading + empty states", () => {
    const { rerender } = render(
      <DocumentSourceSelector {...base} mode="document" onModeChange={() => {}} documentsLoading />,
    );
    expect(screen.getByTestId("source-documents-loading")).toBeInTheDocument();
    rerender(<DocumentSourceSelector {...base} mode="document" onModeChange={() => {}} />);
    expect(screen.getByTestId("source-documents-empty")).toBeInTheDocument();
  });

  it("selects a document", () => {
    const onDocumentChange = vi.fn();
    render(
      <DocumentSourceSelector
        {...base}
        mode="document"
        onModeChange={() => {}}
        documents={[{ id: "doc-001", filename: "spec.docx", projectName: "Alpha" }]}
        onDocumentChange={onDocumentChange}
      />,
    );
    const select = screen.getByTestId("source-document-select");
    fireEvent.change(select, { target: { value: "doc-001" } });
    expect(onDocumentChange).toHaveBeenCalledWith("doc-001");
    fireEvent.change(select, { target: { value: "" } });
    expect(onDocumentChange).toHaveBeenLastCalledWith(null);
  });
});

describe("RunImpactAnalysisButton", () => {
  it("invokes onClick when enabled", () => {
    const onClick = vi.fn();
    render(<RunImpactAnalysisButton disabled={false} isPending={false} onClick={onClick} />);
    const btn = screen.getByTestId("run-impact-analysis");
    expect(btn).toHaveTextContent("Run impact analysis");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it("is disabled while pending and shows pending label", () => {
    render(<RunImpactAnalysisButton disabled={false} isPending onClick={() => {}} />);
    const btn = screen.getByTestId("run-impact-analysis");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Starting…");
  });
});
