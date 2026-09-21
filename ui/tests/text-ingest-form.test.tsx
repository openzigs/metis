/**
 * Issue #121 — unit tests for TextIngestForm (task-ingest-form).
 *
 * Covers: primary render, empty filename/content validation, loading state,
 * success/error states, and onIngested callback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextIngestForm } from "@/components/projects/text-ingest-form";
import { makeWrapper } from "./test-utils";
import { ApiError } from "@/lib/api-client";

vi.mock("@/lib/projects-api", () => ({
  documentsApi: {
    createFromText: vi.fn(),
  },
}));

import { documentsApi } from "@/lib/projects-api";

const createFromText = documentsApi.createFromText as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  createFromText.mockReset();
});

function renderForm(onIngested?: (...args: unknown[]) => void) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <TextIngestForm projectId="p1" onIngested={onIngested as never} />
    </Wrapper>,
  );
}

describe("TextIngestForm", () => {
  it("renders label, filename input, content area and save button", () => {
    renderForm();
    expect(screen.getByLabelText(/Paste text/i)).toBeInTheDocument();
    expect(screen.getByTestId("text-ingest-filename")).toBeInTheDocument();
    expect(screen.getByTestId("text-ingest-content")).toBeInTheDocument();
    expect(screen.getByTestId("text-ingest-submit")).toBeInTheDocument();
  });

  it("save button is disabled when content is empty", () => {
    renderForm();
    expect(screen.getByTestId("text-ingest-submit")).toBeDisabled();
  });

  it("shows error when filename is empty on submit", async () => {
    const user = userEvent.setup();
    renderForm();
    const filename = screen.getByTestId("text-ingest-filename");
    await user.clear(filename);
    const content = screen.getByTestId("text-ingest-content");
    await user.type(content, "some content");
    await user.click(screen.getByTestId("text-ingest-submit"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Filename is required/i),
    );
  });

  it("shows error when content is empty on submit", async () => {
    const user = userEvent.setup();
    renderForm();
    // Content is empty by default — click submit directly (button is disabled,
    // so we have to type content first, then clear it)
    const content = screen.getByTestId("text-ingest-content");
    await user.type(content, "x");
    // Now clear it so it's empty and manually trigger the form
    await user.clear(content);
    // Re-type something into filename to enable submit and then override content
    const filename = screen.getByTestId("text-ingest-filename");
    await user.clear(filename);
    await user.type(filename, "note.md");
    await user.type(content, "test");
    await user.clear(content);
    // Button is disabled when content is empty so use fireEvent directly
    const form = screen.getByTestId("text-ingest-form");
    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Content is required/i),
    );
  });

  it("calls API and shows success message", async () => {
    const user = userEvent.setup();
    const onIngested = vi.fn();
    createFromText.mockResolvedValueOnce({
      document: { filename: "note.md", status: "ready" },
    });
    renderForm(onIngested);
    await user.type(screen.getByTestId("text-ingest-content"), "Hello world");
    await user.click(screen.getByTestId("text-ingest-submit"));
    await waitFor(() => expect(screen.getByText(/Saved note\.md/i)).toBeInTheDocument());
    expect(createFromText).toHaveBeenCalledWith("p1", {
      filename: "note.md",
      content: "Hello world",
    });
    expect(onIngested).toHaveBeenCalled();
  });

  it("shows API error on failure", async () => {
    const user = userEvent.setup();
    createFromText.mockRejectedValueOnce(new ApiError(413, "Content too large"));
    renderForm();
    await user.type(screen.getByTestId("text-ingest-content"), "oversized content");
    await user.click(screen.getByTestId("text-ingest-submit"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Content too large/i));
  });

  it("shows generic error for non-ApiError", async () => {
    const user = userEvent.setup();
    createFromText.mockRejectedValueOnce(new Error("network failure"));
    renderForm();
    await user.type(screen.getByTestId("text-ingest-content"), "some content");
    await user.click(screen.getByTestId("text-ingest-submit"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Import failed/i));
  });

  it("clears content after successful save", async () => {
    const user = userEvent.setup();
    createFromText.mockResolvedValueOnce({
      document: { filename: "note.md", status: "ready" },
    });
    renderForm();
    const content = screen.getByTestId("text-ingest-content");
    await user.type(content, "Hello");
    await user.click(screen.getByTestId("text-ingest-submit"));
    await waitFor(() => expect(content).toHaveValue(""));
  });

  it("shows saving spinner while pending", async () => {
    let resolve!: (v: unknown) => void;
    createFromText.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId("text-ingest-content"), "content");
    await user.click(screen.getByTestId("text-ingest-submit"));
    expect(screen.getByTestId("text-ingest-submit")).toHaveTextContent("Saving…");
    resolve({ document: { filename: "note.md", status: "ready" } });
  });

  it("allows changing the filename before submitting", async () => {
    const user = userEvent.setup();
    createFromText.mockResolvedValueOnce({
      document: { filename: "custom.txt", status: "ready" },
    });
    renderForm();
    const filename = screen.getByTestId("text-ingest-filename");
    await user.clear(filename);
    await user.type(filename, "custom.txt");
    await user.type(screen.getByTestId("text-ingest-content"), "Custom content");
    await user.click(screen.getByTestId("text-ingest-submit"));
    await waitFor(() =>
      expect(createFromText).toHaveBeenCalledWith("p1", {
        filename: "custom.txt",
        content: "Custom content",
      }),
    );
  });
});
