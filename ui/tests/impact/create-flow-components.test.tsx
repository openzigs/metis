import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MultiProjectPicker } from "@/components/impact/multi-project-picker";
import { DocumentSourceSelector } from "@/components/impact/document-source-selector";
import { RunImpactAnalysisButton } from "@/components/impact/run-impact-analysis-button";

const PROJECTS = [
  { id: "project-001", name: "Alpha" },
  { id: "project-002", name: "Beta" },
];

describe("MultiProjectPicker", () => {
  it("communicates single- vs multi-project impact without a two-project minimum", () => {
    render(<MultiProjectPicker projects={PROJECTS} selected={[]} onChange={() => {}} />);
    const helper = screen.getByText(/Pick one deep-ingested project/i);
    expect(helper).toHaveTextContent(/single-project impact/i);
    expect(helper).toHaveTextContent(/two or more/i);
    expect(screen.queryByText(/at least two/i)).not.toBeInTheDocument();
  });

  it("renders loading state", () => {
    render(<MultiProjectPicker projects={[]} selected={[]} onChange={() => {}} isLoading />);
    expect(screen.getByTestId("multi-project-loading")).toBeInTheDocument();
  });

  it("renders empty state", () => {
    render(<MultiProjectPicker projects={[]} selected={[]} onChange={() => {}} />);
    expect(screen.getByTestId("multi-project-empty")).toBeInTheDocument();
  });

  it("selects and deselects a project", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MultiProjectPicker projects={PROJECTS} selected={[]} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("project-checkbox-project-001"));
    expect(onChange).toHaveBeenCalledWith(["project-001"]);

    rerender(
      <MultiProjectPicker projects={PROJECTS} selected={["project-001"]} onChange={onChange} />,
    );
    expect(screen.getByTestId("multi-project-count")).toHaveTextContent("1 selected");
    fireEvent.click(screen.getByTestId("project-checkbox-project-001"));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

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
