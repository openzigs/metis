/**
 * #2555 — "Restrict to…" in the upload dialog: the files are created with the
 * chosen access list, so a document is never open to the whole project while
 * it is indexed. People are picked by name; the summary names them.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AclUserName } from "@/lib/projects-api";

let viewer: { id: string; role: string } | null = { id: "u-bob", role: "developer" };
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: viewer }) }));
const upload = vi.fn();
vi.mock("@/lib/projects-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects-api")>();
  return {
    ...actual,
    documentsApi: { ...actual.documentsApi, upload: (...a: unknown[]) => upload(...a) },
  };
});
const apiFetch = vi.fn();
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));

const { DocumentUploader } = await import("./document-uploader");

const ALICE: AclUserName = { id: "u-alice", username: "asmith", displayName: "Alice Smith" };

function renderUploader() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DocumentUploader projectId="p1" />
    </QueryClientProvider>,
  );
}

function chooseFile(name = "salaries.md") {
  const file = new File([new Uint8Array(10)], name, { type: "text/markdown" });
  fireEvent.change(screen.getByTestId("upload-file-input"), { target: { files: [file] } });
  return file;
}

async function restrictToAlice() {
  fireEvent.click(screen.getByTestId("upload-restrict-toggle"));
  fireEvent.change(screen.getByTestId("acl-person-search"), { target: { value: "alice" } });
  fireEvent.click(await screen.findByTestId("acl-person-option-u-alice"));
}

beforeEach(() => {
  viewer = { id: "u-bob", role: "developer" };
  upload.mockReset();
  upload.mockResolvedValue({
    document: { id: "d-new", filename: "salaries.md" },
    ingest: { status: "queued", chunkCount: 0 },
  });
  apiFetch.mockReset();
  apiFetch.mockResolvedValue([ALICE]);
});

describe("DocumentUploader — Restrict to… (#2555)", () => {
  it("uploads unrestricted by default, and says so", async () => {
    renderUploader();
    expect(screen.getByTestId("upload-restrict-summary")).toHaveTextContent(
      "readable by every project member",
    );
    expect(screen.getByTestId("upload-restrict-toggle")).toHaveAttribute("aria-expanded", "false");
    const file = chooseFile();
    await waitFor(() => expect(upload).toHaveBeenCalledWith("p1", file, []));
  });

  it("creates the files with the chosen list, naming who will read them", async () => {
    renderUploader();
    await restrictToAlice();
    fireEvent.change(screen.getByTestId("acl-kind-select"), { target: { value: "role" } });
    fireEvent.change(screen.getByTestId("acl-role-select"), { target: { value: "coordinator" } });
    fireEvent.click(screen.getByTestId("acl-add"));
    expect(screen.getByTestId("upload-restrict-summary")).toHaveTextContent(
      "readable only by Alice Smith, the coordinator role and admins",
    );
    expect(screen.getByTestId("upload-restrict-subjects")).not.toHaveTextContent("u-alice");
    const file = chooseFile();
    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith("p1", file, [
        { kind: "user", value: "u-alice" },
        { kind: "role", value: "coordinator" },
      ]),
    );
  });

  it("drops a subject removed before the files are chosen", async () => {
    renderUploader();
    await restrictToAlice();
    fireEvent.click(screen.getByRole("button", { name: "Remove Alice Smith" }));
    expect(screen.queryByTestId("upload-restrict-subjects")).toBeNull();
    const file = chooseFile();
    await waitFor(() => expect(upload).toHaveBeenCalledWith("p1", file, []));
  });

  it("warns an uploader the list leaves out, and not one it names", async () => {
    renderUploader();
    await restrictToAlice();
    expect(screen.getByTestId("upload-restrict-lockout")).toHaveTextContent(/not on this list/);
    fireEvent.change(screen.getByTestId("acl-kind-select"), { target: { value: "role" } });
    fireEvent.change(screen.getByTestId("acl-role-select"), { target: { value: "developer" } });
    fireEvent.click(screen.getByTestId("acl-add"));
    expect(screen.queryByTestId("upload-restrict-lockout")).toBeNull();
  });

  it("keeps warning with the panel collapsed, where the files are dropped", async () => {
    renderUploader();
    await restrictToAlice();
    fireEvent.click(screen.getByTestId("upload-restrict-toggle"));
    expect(screen.getByTestId("upload-restrict-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("acl-subject-picker")).toBeNull();
    expect(screen.getByTestId("upload-restrict-lockout")).toHaveTextContent(/not on this list/);
  });
});
