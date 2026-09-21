/**
 * Issue #121 — unit tests for UrlIngestForm (web-ingest-form).
 *
 * Covers: primary render, valid/invalid URL submission, protocol guard,
 * loading/success/error states, and onIngested callback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UrlIngestForm } from "@/components/projects/url-ingest-form";
import { makeWrapper } from "./test-utils";
import { ApiError } from "@/lib/api-client";

vi.mock("@/lib/projects-api", () => ({
  documentsApi: {
    createFromUrl: vi.fn(),
  },
}));

import { documentsApi } from "@/lib/projects-api";

const createFromUrl = documentsApi.createFromUrl as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  createFromUrl.mockReset();
});

function renderForm(onIngested?: (...args: unknown[]) => void) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <UrlIngestForm projectId="p1" onIngested={onIngested as never} />
    </Wrapper>,
  );
}

function setUrl(value: string) {
  fireEvent.change(screen.getByTestId("url-ingest-input"), { target: { value } });
}

function submitForm() {
  fireEvent.submit(screen.getByTestId("url-ingest-form"));
}

describe("UrlIngestForm", () => {
  it("renders label and input", () => {
    renderForm();
    expect(screen.getByLabelText(/Add from URL/i)).toBeInTheDocument();
    expect(screen.getByTestId("url-ingest-input")).toBeInTheDocument();
    expect(screen.getByTestId("url-ingest-submit")).toBeInTheDocument();
  });

  // WCAG SC 1.3.5 (#659): the URL points at project *content* to ingest, not at
  // the user — a browser autofill would be actively wrong here, so the field
  // must carry no autocomplete purpose token.
  it("omits autocomplete on the content-URL input (not user info) (#659)", () => {
    renderForm();
    expect(screen.getByTestId("url-ingest-input")).not.toHaveAttribute("autocomplete");
  });

  it("submit button is disabled when URL is empty", () => {
    renderForm();
    expect(screen.getByTestId("url-ingest-submit")).toBeDisabled();
  });

  it("enables submit when URL is non-empty", () => {
    renderForm();
    setUrl("https://example.com/doc.md");
    expect(screen.getByTestId("url-ingest-submit")).not.toBeDisabled();
  });

  it("shows error for invalid URL", async () => {
    renderForm();
    setUrl("not-a-url");
    submitForm();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/valid http/i));
  });

  // SC 3.3.3 (#663): a scheme-less but otherwise real host gets a concrete
  // corrected-URL suggestion, not just "invalid".
  it("suggests an https-prefixed URL for a scheme-less host (#663)", async () => {
    renderForm();
    setUrl("example.com/docs/page.md");
    submitForm();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /did you mean “https:\/\/example\.com\/docs\/page\.md”/i,
      ),
    );
  });

  it("shows error for non-http protocol", async () => {
    renderForm();
    setUrl("ftp://example.com/file.md");
    submitForm();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/http and https/i));
  });

  // SC 3.3.3 (#663): an unsupported scheme is rewritten to https in the hint.
  it("suggests swapping an unsupported scheme to https (#663)", async () => {
    renderForm();
    setUrl("ftp://example.com/file.md");
    submitForm();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /did you mean “https:\/\/example\.com\/file\.md”/i,
      ),
    );
  });

  it("calls API with valid https URL and shows success", async () => {
    const onIngested = vi.fn();
    createFromUrl.mockResolvedValueOnce({
      document: { filename: "page.md", status: "ready" },
    });
    renderForm(onIngested);
    setUrl("https://example.com/docs/page.md");
    submitForm();
    await waitFor(() => expect(screen.getByText(/Imported page\.md/i)).toBeInTheDocument());
    expect(createFromUrl).toHaveBeenCalledWith("p1", {
      url: "https://example.com/docs/page.md",
    });
    expect(onIngested).toHaveBeenCalled();
  });

  it("calls API with valid http URL", async () => {
    createFromUrl.mockResolvedValueOnce({
      document: { filename: "doc.md", status: "processing" },
    });
    renderForm();
    setUrl("http://internal/doc.md");
    submitForm();
    await waitFor(() => expect(screen.getByText(/Imported doc\.md/i)).toBeInTheDocument());
  });

  it("shows API error message on failure", async () => {
    createFromUrl.mockRejectedValueOnce(new ApiError(422, "URL blocked by SSRF filter"));
    renderForm();
    setUrl("https://192.168.1.1/file");
    submitForm();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/URL blocked by SSRF filter/i),
    );
  });

  it("shows generic error message for non-ApiError", async () => {
    createFromUrl.mockRejectedValueOnce(new Error("network error"));
    renderForm();
    setUrl("https://example.com/file.md");
    submitForm();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Import failed/i));
  });

  it("clears the URL input after a successful import", async () => {
    createFromUrl.mockResolvedValueOnce({
      document: { filename: "doc.md", status: "ready" },
    });
    renderForm();
    const input = screen.getByTestId("url-ingest-input");
    setUrl("https://example.com/doc.md");
    submitForm();
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("disables button and shows Fetching… while pending", async () => {
    let resolve!: (v: unknown) => void;
    createFromUrl.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    renderForm();
    setUrl("https://example.com/slow.md");
    submitForm();
    await waitFor(() => expect(screen.getByTestId("url-ingest-submit")).toBeDisabled());
    expect(screen.getByTestId("url-ingest-submit")).toHaveTextContent("Fetching…");
    resolve({ document: { filename: "slow.md", status: "ready" } });
  });
});
