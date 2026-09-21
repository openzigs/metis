/**
 * Tests for the Spec Kit Mode page (Epic #193, /projects/[id]/spec-kit).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => ({ id: "p1" }),
    usePathname: () => "/projects/p1/spec-kit",
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock("@/lib/spec-kit-api", () => ({
  specKitApi: {
    getEnabled: vi.fn(),
    setEnabled: vi.fn(),
    listFiles: vi.fn(),
    getFile: vi.fn(),
    putFile: vi.fn(),
    deleteFile: vi.fn(),
    generateConstitution: vi.fn(),
    runCommand: vi.fn(),
  },
}));

// Epic #34 — the page now mounts PresenceAvatars (socket) and CommentPanel
// (collaboration-api). Mock both so the existing page tests stay hermetic.
vi.mock("@/lib/socket-client", () => ({
  useSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

// Issue #423 — the command/constitution mutations now fire terminal toasts.
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}));

vi.mock("@/lib/collaboration-api", () => ({
  commentApi: {
    listForArtifact: vi.fn().mockResolvedValue([]),
    createForArtifact: vi.fn(),
    listForRequirement: vi.fn().mockResolvedValue([]),
    createForRequirement: vi.fn(),
    reply: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
  },
}));

import { specKitApi } from "@/lib/spec-kit-api";
import { commentApi } from "@/lib/collaboration-api";
import SpecKitPage from "@/app/(authed)/projects/[id]/spec-kit/page";

const collabMock = commentApi as unknown as {
  listForArtifact: ReturnType<typeof vi.fn>;
};

const m = specKitApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function artifact(name: string, content = "body", version = 1) {
  return {
    id: `a_${name}`,
    projectId: "p1",
    name,
    content,
    version,
    updatedById: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  for (const key of Object.keys(m)) m[key]!.mockReset();
  m.getEnabled!.mockResolvedValue({ enabled: true });
  m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [] });
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("SpecKitPage", () => {
  it("renders the artifact tree, toggle, and slash-command palette", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-root")).toBeInTheDocument());
    expect(screen.getByTestId("spec-kit-tree")).toBeInTheDocument();
    expect(screen.getByTestId("spec-kit-artifact-spec.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-toggle")).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("shows a disabled banner when Spec Kit is off", async () => {
    m.getEnabled!.mockResolvedValue({ enabled: false });
    m.listFiles!.mockResolvedValue({ enabled: false, artifacts: [] });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-disabled-banner")).toBeInTheDocument());
    expect(screen.getByTestId("spec-kit-toggle")).toHaveAttribute("aria-checked", "false");
  });

  it("renders the empty banner for a missing artifact", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-empty-banner")).toBeInTheDocument());
  });

  it("renders the artifact contents and version when present", async () => {
    m.listFiles!.mockResolvedValue({
      enabled: true,
      artifacts: [artifact("spec.md", "# Spec\nbody", 3)],
    });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-content")).toHaveTextContent("# Spec"));
    expect(screen.getByTestId("spec-kit-artifact-spec.md")).toHaveTextContent("v3");
  });

  it("toggles Spec Kit Mode via PUT /enabled", async () => {
    m.setEnabled!.mockResolvedValue({ enabled: false });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-toggle")).toHaveAttribute("aria-checked", "true"),
    );
    fireEvent.click(screen.getByTestId("spec-kit-toggle"));
    await waitFor(() => expect(m.setEnabled).toHaveBeenCalledWith("p1", false));
  });

  it("dispatches /specify and surfaces the grounded result message + success toast", async () => {
    const grounded = "Generated spec.md (v3) in 1320 tokens — grounded on 8 retrieved chunks.";
    m.runCommand!.mockResolvedValue({
      command: "specify",
      artifactName: "spec.md",
      artifact: artifact("spec.md", "## Spec body", 1),
      message: grounded,
      tokensUsed: 25,
    });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
      target: { value: "/specify build a billing dashboard" },
    });
    fireEvent.click(screen.getByTestId("spec-kit-run-button"));
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenCalledWith("p1", "specify", "build a billing dashboard"),
    );
    await waitFor(() => expect(screen.getByTestId("spec-kit-result")).toHaveTextContent(grounded));
    // #423 — the grounded-completion line is preserved verbatim as the toast.
    expect(toastSuccess).toHaveBeenCalledWith(grounded);
  });

  it("fires a user-safe error toast when a command fails (#423)", async () => {
    m.runCommand!.mockRejectedValue(new Error("boom internal stack"));
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
      target: { value: "/specify go" },
    });
    fireEvent.click(screen.getByTestId("spec-kit-run-button"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The Spec Kit operation failed. Please try again."),
    );
    // No raw error in the toast.
    expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining("stack"));
  });

  it("shows slash-command suggestions while typing", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
      target: { value: "/sp" },
    });
    expect(screen.getByTestId("spec-kit-suggestion-specify")).toBeInTheDocument();
  });

  it("shows an error when the buffer is not a slash command", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByTestId("spec-kit-run-button"));
    await waitFor(() => expect(screen.getByTestId("spec-kit-error")).toBeInTheDocument());
  });

  it("edits an artifact and saves via PUT /files/:name", async () => {
    m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [artifact("spec.md", "old")] });
    m.putFile!.mockResolvedValue({ artifact: artifact("spec.md", "new", 2) });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-edit-button")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("spec-kit-edit-button"));
    fireEvent.change(screen.getByTestId("spec-kit-editor"), { target: { value: "new" } });
    fireEvent.click(screen.getByTestId("spec-kit-save-button"));
    await waitFor(() => expect(m.putFile).toHaveBeenCalledWith("p1", "spec.md", "new"));
  });

  it("triggers constitution generation and surfaces a confirmation in the result card", async () => {
    m.generateConstitution!.mockResolvedValue({
      artifact: artifact("constitution.md", "# Constitution", 1),
      contentLength: 1000,
    });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-generate-constitution")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("spec-kit-generate-constitution"));
    await waitFor(() => expect(m.generateConstitution).toHaveBeenCalledWith("p1"));
    // The endpoint returns no `message`, so the page must surface its own
    // confirmation (otherwise the result card keeps the previous command text).
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-result")).toHaveTextContent(
        "Generated constitution.md (v1).",
      ),
    );
  });

  it("fills the buffer when a suggestion is clicked", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("spec-kit-command-input"), { target: { value: "/sp" } });
    fireEvent.click(screen.getByTestId("spec-kit-suggestion-specify"));
    expect((screen.getByTestId("spec-kit-command-input") as HTMLInputElement).value).toBe(
      "/specify ",
    );
  });

  it("submits via the Enter key", async () => {
    m.runCommand!.mockResolvedValue({
      command: "specify",
      artifactName: "spec.md",
      artifact: artifact("spec.md"),
      message: "ok",
      tokensUsed: 1,
    });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    const input = screen.getByTestId("spec-kit-command-input");
    fireEvent.change(input, { target: { value: "/specify go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(m.runCommand).toHaveBeenCalledWith("p1", "specify", "go"));
  });

  it("cancels in-flight artifact edits", async () => {
    m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [artifact("spec.md", "old")] });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-edit-button")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("spec-kit-edit-button"));
    fireEvent.change(screen.getByTestId("spec-kit-editor"), { target: { value: "abandoned" } });
    fireEvent.click(screen.getByTestId("spec-kit-cancel-button"));
    expect(screen.queryByTestId("spec-kit-editor")).not.toBeInTheDocument();
    expect(screen.getByTestId("spec-kit-content")).toHaveTextContent("old");
  });

  // ---- Epic #34 collaboration mounts -------------------------------------

  it("opens the comment panel scoped to the selected artifact (AC1)", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-comments-button")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("spec-kit-comments-button"));
    // Panel self-fetches comments for the default artifact (spec.md) on project p1.
    await waitFor(() => expect(collabMock.listForArtifact).toHaveBeenCalledWith("p1", "spec.md"));
    // The panel heading names the scoped artifact.
    expect(screen.getByRole("heading", { name: /Comments — spec.md/i })).toBeInTheDocument();
  });

  it("scopes the comment panel to the artifact the user selected (AC1)", async () => {
    m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [artifact("plan.md", "p")] });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-artifact-plan.md")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("spec-kit-artifact-plan.md"));
    fireEvent.click(screen.getByTestId("spec-kit-comments-button"));
    await waitFor(() => expect(collabMock.listForArtifact).toHaveBeenCalledWith("p1", "plan.md"));
  });

  // ---- #372 BA/PM "author the intent" framing (copy only) ----------------

  it("frames the header as the BA/PM author-the-intent front-door", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-root")).toBeInTheDocument());
    // Title still names the feature; subtitle carries the BA/PM intent framing.
    expect(screen.getByRole("heading", { name: /Spec Kit/i, level: 1 })).toBeInTheDocument();
    const subtitle = screen.getByTestId("spec-kit-subtitle");
    expect(subtitle).toHaveTextContent(/author the intent/i);
    expect(subtitle).toHaveTextContent(/spec → plan → tasks/i);
  });

  it("explains the spec → plan → tasks flow and links to Analysis in the empty state", async () => {
    // No artifacts yet → the onboarding empty state should render.
    m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [] });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    const onboarding = await screen.findByTestId("spec-kit-onboarding");
    expect(onboarding).toHaveTextContent(/spec → plan → tasks/i);
    // Links to the adjacent Analysis surface as the downstream consumer.
    const analysisLink = screen.getByTestId("spec-kit-analysis-link");
    expect(analysisLink).toHaveAttribute("href", "/projects/p1/analysis");
    // Manual handoff — must NOT claim /implement auto-runs the pipeline.
    expect(onboarding.textContent ?? "").not.toMatch(/auto(?:matically)?[- ]?run/i);
  });

  it("hides the onboarding panel once an artifact exists", async () => {
    m.listFiles!.mockResolvedValue({
      enabled: true,
      artifacts: [artifact("spec.md", "# Spec", 1)],
    });
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("spec-kit-content")).toBeInTheDocument());
    expect(screen.queryByTestId("spec-kit-onboarding")).not.toBeInTheDocument();
  });

  it("reframes the slash-command palette help text for intent authoring", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper() });
    const help = await screen.findByTestId("spec-kit-palette-help");
    expect(help).toHaveTextContent(/author/i);
    expect(help).toHaveTextContent(/spec → plan → tasks/i);
  });
});
