/**
 * Tests for the Spec Kit Mode page (Epic #193, /projects/[id]/spec-kit).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { makeWrapper, TEST_USER } from "./test-utils";
import type { AuthUser } from "@/lib/auth-types";

// #735 — mutable so a test can open the page from a mention link.
const nav = vi.hoisted(() => ({ search: "" }));
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => ({ id: "p1" }),
    usePathname: () => "/projects/p1/spec-kit",
    useRouter: () => ({
      push: routerPush,
      replace: routerReplace,
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(nav.search),
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
    listFeatures: vi.fn(),
    listFeatureArtifacts: vi.fn(),
    featureStatus: vi.fn(),
    archiveFeature: vi.fn(),
    restoreFeature: vi.fn(),
    deleteFeatureArtifact: vi.fn(),
  },
}));

// #953 — the vault picker has its own suite (vault-picker.test.tsx); here it is a
// plain input so a test can pick a `${vault:label}` without driving the Select.
vi.mock("@/components/connectors/vault-picker", () => ({
  VaultPicker: (props: { id?: string; value: string; onChange: (v: string) => void }) => (
    <input
      id={props.id}
      data-testid="spec-kit-export-secret"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

// #789 — "Start analysis with these artifacts".
const startAnalysis = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysis-api", () => ({ analysisApi: { start: startAnalysis } }));

// Epic #34 — the page now mounts PresenceAvatars (socket) and CommentPanel
// (collaboration-api). Mock both so the existing page tests stay hermetic.
vi.mock("@/lib/socket-client", () => ({
  useSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

// Issue #423 — the command/constitution mutations now fire terminal toasts.
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    // #993 — options (the created-issue links) are passed through only when given.
    success: (msg: string, opts?: unknown) =>
      opts === undefined ? toastSuccess(msg) : toastSuccess(msg, opts),
    error: (msg: string) => toastError(msg),
    warning: (msg: string) => toastWarning(msg),
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
import { ApiError } from "@/lib/api-client";
import { createQueryClient } from "@/lib/query-client";

const collabMock = commentApi as unknown as {
  listForArtifact: ReturnType<typeof vi.fn>;
};

const m = specKitApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

// #789 — every write on the page is `project.update` server-side, so the page
// enables its write controls only for a viewer who holds it.
const WRITER: AuthUser = {
  ...TEST_USER,
  role: "developer",
  permissions: ["project.read", "project.update"],
};
const READER: AuthUser = { ...TEST_USER, role: "developer", permissions: ["project.read"] };

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
  nav.search = "";
  window.sessionStorage.clear();
  routerReplace.mockReset();
  for (const key of Object.keys(m)) m[key]!.mockReset();
  m.getEnabled!.mockResolvedValue({ enabled: true });
  m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [] });
  m.listFeatures!.mockResolvedValue({ features: [] });
  m.featureStatus!.mockResolvedValue({ slug: "" });
  startAnalysis.mockReset();
  routerPush.mockReset();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("SpecKitPage", () => {
  it("opens the linked artifact's comments from a mention link (#735)", async () => {
    nav.search = "artifact=plan.md";
    collabMock.listForArtifact.mockClear();

    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });

    await waitFor(() => expect(collabMock.listForArtifact).toHaveBeenCalledWith("p1", "plan.md"));
  });

  it("ignores a linked artifact name that is not a Spec Kit artifact", async () => {
    nav.search = "artifact=..%2Fsecrets";
    collabMock.listForArtifact.mockClear();

    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });

    await waitFor(() => expect(screen.getByTestId("spec-kit-root")).toBeInTheDocument());
    expect(collabMock.listForArtifact).not.toHaveBeenCalled();
  });

  it("renders the artifact tree, toggle, and slash-command palette", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
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
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-disabled-banner")).toBeInTheDocument());
    expect(screen.getByTestId("spec-kit-toggle")).toHaveAttribute("aria-checked", "false");
  });

  it("renders the empty banner for a missing artifact", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-empty-banner")).toBeInTheDocument());
  });

  it("renders the artifact contents and version when present", async () => {
    m.listFiles!.mockResolvedValue({
      enabled: true,
      artifacts: [artifact("spec.md", "# Spec\nbody", 3)],
    });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    // #945 — rendered Markdown, not the raw `# Spec` source.
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Spec" })).toBeInTheDocument(),
    );
    expect(screen.getByTestId("spec-kit-content")).not.toHaveTextContent("# Spec");
    expect(screen.getByTestId("spec-kit-artifact-spec.md")).toHaveTextContent("v3");
  });

  it("toggles Spec Kit Mode via PUT /enabled", async () => {
    m.setEnabled!.mockResolvedValue({ enabled: false });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
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
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
      target: { value: "/specify build a billing dashboard" },
    });
    fireEvent.click(screen.getByTestId("spec-kit-run-button"));
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenCalledWith("p1", "speckit.specify", {
        input: "build a billing dashboard",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("spec-kit-result")).toHaveTextContent(grounded));
    // #423 — the grounded-completion line is preserved verbatim as the toast.
    expect(toastSuccess).toHaveBeenCalledWith(grounded);
  });

  it("fires a user-safe error toast when a command fails (#423)", async () => {
    m.runCommand!.mockRejectedValue(new Error("boom internal stack"));
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
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
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
      target: { value: "/sp" },
    });
    expect(screen.getByTestId("spec-kit-suggestion-speckit.specify")).toBeInTheDocument();
  });

  it("shows an error when the buffer is not a slash command", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
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
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
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
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
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

  it("#788 shows the server's message, which says when only a skeleton was written", async () => {
    m.generateConstitution!.mockResolvedValue({
      artifact: artifact("constitution.md", "# Constitution", 2),
      contentLength: 300,
      grounded: false,
      meta: null,
      message:
        "Wrote a constitution skeleton with no principles — no project knowledge was retrieved.",
    });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-generate-constitution")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("spec-kit-generate-constitution"));
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-result")).toHaveTextContent(
        "Wrote a constitution skeleton with no principles — no project knowledge was retrieved.",
      ),
    );
    expect(screen.getByTestId("spec-kit-result")).not.toHaveTextContent(
      "Generated constitution.md",
    );
    // A skeleton is a warning, not a success.
    expect(toastWarning).toHaveBeenCalledWith(expect.stringContaining("skeleton"));
    expect(toastSuccess).not.toHaveBeenCalledWith(expect.stringContaining("skeleton"));
  });

  it("fills the buffer when a suggestion is clicked", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("spec-kit-command-input"), { target: { value: "/sp" } });
    fireEvent.click(screen.getByTestId("spec-kit-suggestion-speckit.specify"));
    expect((screen.getByTestId("spec-kit-command-input") as HTMLInputElement).value).toBe(
      "/speckit.specify ",
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
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    const input = screen.getByTestId("spec-kit-command-input");
    fireEvent.change(input, { target: { value: "/specify go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenCalledWith("p1", "speckit.specify", { input: "go" }),
    );
  });

  it("cancels in-flight artifact edits", async () => {
    m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [artifact("spec.md", "old")] });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-edit-button")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("spec-kit-edit-button"));
    fireEvent.change(screen.getByTestId("spec-kit-editor"), { target: { value: "abandoned" } });
    fireEvent.click(screen.getByTestId("spec-kit-cancel-button"));
    expect(screen.queryByTestId("spec-kit-editor")).not.toBeInTheDocument();
    expect(screen.getByTestId("spec-kit-content")).toHaveTextContent("old");
  });

  // ---- Epic #34 collaboration mounts -------------------------------------

  it("opens the comment panel scoped to the selected artifact (AC1)", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-comments-button")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("spec-kit-comments-button"));
    // Panel self-fetches comments for the default artifact (spec.md) on project p1.
    await waitFor(() => expect(collabMock.listForArtifact).toHaveBeenCalledWith("p1", "spec.md"));
    // The panel heading names the scoped artifact.
    expect(screen.getByRole("heading", { name: /Comments — spec.md/i })).toBeInTheDocument();
  });

  it("scopes the comment panel to the artifact the user selected (AC1)", async () => {
    m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [artifact("plan.md", "p")] });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-artifact-plan.md")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("spec-kit-artifact-plan.md"));
    fireEvent.click(screen.getByTestId("spec-kit-comments-button"));
    await waitFor(() => expect(collabMock.listForArtifact).toHaveBeenCalledWith("p1", "plan.md"));
  });

  // ---- #372 BA/PM "author the intent" framing (copy only) ----------------

  it("frames the header as the BA/PM author-the-intent front-door", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
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
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
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
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-content")).toBeInTheDocument());
    expect(screen.queryByTestId("spec-kit-onboarding")).not.toBeInTheDocument();
  });

  it("reframes the slash-command palette help text for intent authoring", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    const help = await screen.findByTestId("spec-kit-palette-help");
    expect(help).toHaveTextContent(/author/i);
    expect(help).toHaveTextContent(/spec → plan → tasks/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #789 — speckit.* palette, features, checklist, export, delete, handoff.
// ─────────────────────────────────────────────────────────────────────────────
describe("SpecKitPage — #789", () => {
  const FEATURE = {
    id: "f1",
    slug: "001-a",
    title: "Mark read",
    status: "planned",
    branchName: null,
    updatedAt: new Date().toISOString(),
  };
  const fa = (key: string, content = `${key} body`) => ({
    id: `fa_${key}`,
    key,
    content,
    version: 2,
    updatedAt: new Date().toISOString(),
  });

  async function openFeature(user: AuthUser = WRITER): Promise<void> {
    m.listFeatures!.mockResolvedValue({ features: [FEATURE] });
    m.listFeatureArtifacts!.mockResolvedValue({
      feature: FEATURE,
      artifacts: [fa("spec.md", "FR-1 mark entries read"), fa("plan.md"), fa("contracts/api.yaml")],
    });
    m.featureStatus!.mockResolvedValue({
      slug: "001-a",
      specGate: true,
      planGate: true,
      tasksGate: false,
      implementGate: false,
      lastUpdated: new Date().toISOString(),
    });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: user }) });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /001-a — Mark read/ })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("spec-kit-feature-select"), {
      target: { value: "001-a" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-content")).toHaveTextContent("FR-1 mark entries read"),
    );
  }

  /** A dry run of `speckit.taskstoissues` on a server that can publish. */
  const DRY_RUN = {
    message: "Would export 2 task(s) to me/sandbox.",
    count: 2,
    repo: { owner: "me", name: "sandbox" },
    parentEpicNumber: null,
    publishAvailable: true,
    created: [
      { taskId: "T01", title: "[T01] Build A", issueNumber: 0, url: "dryrun://a", upserted: false },
      { taskId: "T02", title: "[T02] Build B", issueNumber: 0, url: "dryrun://b", upserted: false },
    ],
    tasksVersion: 3,
    planDigest: "d".repeat(64),
    credentialCheck: "resolved",
  };
  const SECRET = "${vault:gh-sandbox}";

  /** #953 — pick the export's GitHub token (a vault reference). */
  function pickSecret(ref = SECRET): void {
    fireEvent.change(screen.getByTestId("spec-kit-export-secret"), { target: { value: ref } });
  }

  /** Let a mutation that WOULD have been fired run, so a not-called assertion means something. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  /** Answer the confirmation dialog (#268: AlertDialog, never window.confirm). */
  async function answerDialog(label: string): Promise<void> {
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
  }

  function typeAndRun(text: string): void {
    fireEvent.change(screen.getByTestId("spec-kit-command-input"), { target: { value: text } });
    fireEvent.click(screen.getByTestId("spec-kit-run-button"));
  }

  /** The project-level write controls (no feature selected). */
  const PROJECT_WRITES = [
    "spec-kit-toggle",
    "spec-kit-generate-constitution",
    "spec-kit-edit-button",
    "spec-kit-delete-button",
    "spec-kit-command-input",
    "spec-kit-run-button",
  ];
  /** The per-feature write controls. */
  const FEATURE_WRITES = [
    "spec-kit-run-checklist",
    "spec-kit-export-preview",
    "spec-kit-export-publish",
    "spec-kit-feature-archive",
  ];

  async function openProjectArtifact(user: AuthUser): Promise<void> {
    m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [artifact("spec.md", "S")] });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: user }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-content")).toHaveTextContent("S"));
  }

  it("disables every project-level write for a viewer without project.update, with the reason", async () => {
    await openProjectArtifact(READER);
    for (const id of PROJECT_WRITES) {
      const el = screen.getByTestId(id);
      expect(el, id).toBeDisabled();
      expect(el, id).toHaveAttribute("title", "Requires project.update");
    }
    // Reading stays available: the artifact is shown and comments still open.
    expect(screen.getByTestId("spec-kit-content")).toHaveTextContent("S");
    expect(screen.getByTestId("spec-kit-comments-button")).toBeEnabled();
  });

  it("sends no write when a viewer without project.update clicks the gated controls", async () => {
    await openProjectArtifact(READER);
    fireEvent.click(screen.getByTestId("spec-kit-toggle"));
    fireEvent.click(screen.getByTestId("spec-kit-generate-constitution"));
    fireEvent.click(screen.getByTestId("spec-kit-edit-button"));
    fireEvent.click(screen.getByTestId("spec-kit-delete-button"));
    await flush();
    expect(m.setEnabled).not.toHaveBeenCalled();
    expect(m.generateConstitution).not.toHaveBeenCalled();
    expect(screen.queryByTestId("spec-kit-editor")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("enables every project-level write for a viewer with project.update, and only for them", async () => {
    // The same page, as a reader first: the writer's controls are the gate's, not a default.
    await openProjectArtifact(READER);
    expect(screen.getByTestId("spec-kit-edit-button")).toBeDisabled();
    cleanup();
    await openProjectArtifact(WRITER);
    for (const id of PROJECT_WRITES) {
      const el = screen.getByTestId(id);
      expect(el, id).toBeEnabled();
      expect(el, id).not.toHaveAttribute("title");
    }
  });

  it("disables every feature write for a viewer without project.update", async () => {
    await openFeature(READER);
    for (const id of FEATURE_WRITES) {
      const el = screen.getByTestId(id);
      expect(el, id).toBeDisabled();
      expect(el, id).toHaveAttribute("title", "Requires project.update");
    }
    // The feature's artifacts and gates are still readable.
    expect(screen.getByTestId("spec-kit-feature-tree")).toBeInTheDocument();
    expect(screen.getByTestId("spec-kit-feature-gates")).toBeInTheDocument();
  });

  it("enables the feature writes (Publish once a dry run is done) with project.update, and only for them", async () => {
    await openFeature(READER);
    expect(screen.getByTestId("spec-kit-run-checklist")).toBeDisabled();
    cleanup();
    await openFeature(WRITER);
    for (const id of FEATURE_WRITES.filter((i) => i !== "spec-kit-export-publish")) {
      expect(screen.getByTestId(id), id).toBeEnabled();
    }
    m.runCommand!.mockResolvedValue(DRY_RUN);
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).toBeEnabled());
  });

  it("suggests the speckit.* commands, including those with no legacy alias", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
      target: { value: "/speckit" },
    });
    expect(screen.getByTestId("spec-kit-suggestion-speckit.checklist")).toBeInTheDocument();
    expect(screen.getByTestId("spec-kit-suggestion-speckit.taskstoissues")).toBeInTheDocument();
    expect(screen.getByTestId("spec-kit-suggestion-speckit.constitution")).toBeInTheDocument();
  });

  it("refuses a per-feature command with no feature selected, sending nothing", async () => {
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    typeAndRun("/plan the approach");
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-error")).toHaveTextContent(/Select a feature first/),
    );
    expect(m.runCommand).not.toHaveBeenCalled();
  });

  it("selecting a feature shows its artifact tree, gates and scopes the palette", async () => {
    m.runCommand!.mockResolvedValue({ message: "planned", artifacts: [{ key: "plan.md" }] });
    await openFeature();
    expect(screen.getByTestId("spec-kit-viewer-title")).toHaveTextContent("specs/001-a/spec.md");
    expect(screen.getByTestId("spec-kit-feature-artifact-contracts/api.yaml")).toBeInTheDocument();
    expect(screen.queryByTestId("spec-kit-tree")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-gate-planGate")).toHaveAttribute("data-met", "true"),
    );
    expect(screen.getByTestId("spec-kit-gate-tasksGate")).toHaveAttribute("data-met", "false");
    // Feature artifacts carry no project comment thread.
    expect(screen.queryByTestId("spec-kit-comments-button")).not.toBeInTheDocument();

    typeAndRun("/speckit.plan");
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenCalledWith("p1", "speckit.plan", {
        input: "",
        featureSlug: "001-a",
      }),
    );
    // The viewer follows the artifact the command wrote.
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-viewer-title")).toHaveTextContent("specs/001-a/plan.md"),
    );
  });

  it("follows the feature artifact a feature-scoped /speckit.tasks wrote", async () => {
    // The server answers with the artifact's name, which in a feature is its key.
    m.runCommand!.mockResolvedValue({
      command: "tasks",
      artifactName: "plan.md",
      artifact: { key: "plan.md" },
      message: "Generated tasks",
      featureSlug: "001-a",
    });
    await openFeature();
    typeAndRun("/speckit.tasks");
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-viewer-title")).toHaveTextContent("specs/001-a/plan.md"),
    );
  });

  it("keeps the constitution project-scoped while a feature is selected", async () => {
    m.runCommand!.mockResolvedValue({ message: "ok", artifactName: "constitution.md" });
    await openFeature();
    typeAndRun("/speckit.constitution # Core Principles");
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenCalledWith("p1", "speckit.constitution", {
        input: "# Core Principles",
      }),
    );
  });

  it("opens the feature /speckit.specify created", async () => {
    m.listFeatures!.mockResolvedValue({ features: [] });
    m.listFeatureArtifacts!.mockResolvedValue({ feature: FEATURE, artifacts: [fa("spec.md")] });
    m.runCommand!.mockResolvedValue({
      message: "Generated spec.md",
      feature: { ...FEATURE, slug: "002-b" },
      artifact: { key: "spec.md" },
    });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    typeAndRun("/speckit.specify mark entries read");
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-viewer-title")).toHaveTextContent("specs/002-b/spec.md"),
    );
    expect(m.listFeatureArtifacts).toHaveBeenCalledWith("p1", "002-b");
  });

  it("lists archived features on request and archives the selected one", async () => {
    m.archiveFeature!.mockResolvedValue({ feature: { ...FEATURE, status: "archived" } });
    await openFeature();
    fireEvent.click(screen.getByTestId("spec-kit-show-archived"));
    await waitFor(() => expect(m.listFeatures).toHaveBeenCalledWith("p1", true));
    fireEvent.click(screen.getByTestId("spec-kit-feature-archive"));
    await waitFor(() => expect(m.archiveFeature).toHaveBeenCalledWith("p1", "001-a"));
    expect(toastSuccess).toHaveBeenCalledWith("Archived 001-a.");
  });

  it("restores an archived feature", async () => {
    m.listFeatures!.mockResolvedValue({ features: [{ ...FEATURE, status: "archived" }] });
    m.listFeatureArtifacts!.mockResolvedValue({ feature: FEATURE, artifacts: [] });
    m.featureStatus!.mockResolvedValue({ slug: "001-a" });
    m.restoreFeature!.mockResolvedValue({ feature: FEATURE });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /001-a — Mark read \(archived\)/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByTestId("spec-kit-feature-select"), {
      target: { value: "001-a" },
    });
    fireEvent.click(await screen.findByTestId("spec-kit-feature-restore"));
    await waitFor(() => expect(m.restoreFeature).toHaveBeenCalledWith("p1", "001-a"));
  });

  it("runs the checklist for the selected feature", async () => {
    m.runCommand!.mockResolvedValue({
      message: "Generated 5 checklist(s)",
      artifacts: [{ key: "checklist-security.md" }],
    });
    await openFeature();
    fireEvent.click(screen.getByTestId("spec-kit-run-checklist"));
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenCalledWith("p1", "speckit.checklist", {
        featureSlug: "001-a",
      }),
    );
  });

  it("publishes issues only after a dry run, and only after confirmation", async () => {
    m.runCommand!.mockResolvedValue(DRY_RUN);
    await openFeature();
    expect(screen.getByTestId("spec-kit-export-publish")).toBeDisabled();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenCalledWith("p1", "speckit.taskstoissues", {
        featureSlug: "001-a",
        dryRun: true,
        secretRef: SECRET,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("spec-kit-export-publish"));
    expect(m.runCommand).toHaveBeenCalledTimes(1);
    await answerDialog("Publish");
    // #953 — the live run carries the dry run's plan and the same vault secret.
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenCalledWith("p1", "speckit.taskstoissues", {
        featureSlug: "001-a",
        dryRun: false,
        secretRef: SECRET,
        expectedPlan: { tasksVersion: 3, digest: "d".repeat(64) },
      }),
    );
    // A publish is not a preview: publishing again needs a new dry run.
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).toBeDisabled());
  });

  it("keeps Publish disabled, saying why, when the server cannot publish yet (#936)", async () => {
    m.runCommand!.mockResolvedValue({ ...DRY_RUN, publishAvailable: false });
    await openFeature();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-export-unavailable")).toHaveTextContent(
        /not available on this server yet/,
      ),
    );
    const publish = screen.getByTestId("spec-kit-export-publish");
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute(
      "title",
      expect.stringMatching(/not available on this server yet/),
    );
    fireEvent.click(publish);
    await flush();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(m.runCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps Publish disabled, saying why, when the dry run had no vault secret (#953)", async () => {
    m.runCommand!.mockResolvedValue({ ...DRY_RUN, credentialCheck: "missing" });
    await openFeature();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-export-credential")).toHaveTextContent(
        /No GitHub token picked/,
      ),
    );
    const publish = screen.getByTestId("spec-kit-export-publish");
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute("title", expect.stringMatching(/token from the vault/));
  });

  it("shows a task another export holds as in progress, not new, and blocks Publish (#962)", async () => {
    m.runCommand!.mockResolvedValue({
      ...DRY_RUN,
      created: [
        { ...DRY_RUN.created[0]!, state: "in_progress" },
        { ...DRY_RUN.created[1]!, state: "new" },
      ],
    });
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    const claims = await screen.findByTestId("spec-kit-export-claims");
    expect(within(claims).getByRole("listitem")).toHaveTextContent("[T01] Build A — in progress");
    expect(
      within(screen.getByTestId("spec-kit-export-titles"))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["[T02] Build B"]);
    const publish = screen.getByTestId("spec-kit-export-publish");
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute("title", expect.stringMatching(/still running/));
    expect(screen.getByTestId("spec-kit-export-clear")).toBeEnabled();
  });

  it("shows an abandoned claim as 'will reconcile', publishes it, and offers Clear stuck export (#962)", async () => {
    m.runCommand!.mockResolvedValue({
      ...DRY_RUN,
      created: [
        { ...DRY_RUN.created[0]!, state: "reconcile" },
        { ...DRY_RUN.created[1]!, upserted: true, state: "exported" },
      ],
    });
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    const claims = await screen.findByTestId("spec-kit-export-claims");
    expect(within(claims).getByRole("listitem")).toHaveTextContent(
      "[T01] Build A — abandoned, will reconcile",
    );
    expect(screen.queryByTestId("spec-kit-export-titles")).toBeNull();
    // Reconciling is still work for Publish to do.
    expect(screen.getByTestId("spec-kit-export-publish")).toBeEnabled();
    fireEvent.click(screen.getByTestId("spec-kit-export-clear"));
    await answerDialog("Clear stuck export");
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenCalledWith("p1", "speckit.taskstoissues", {
        featureSlug: "001-a",
        clearStuckClaims: true,
        secretRef: SECRET,
      }),
    );
  });

  it("keeps Clear stuck export disabled once the vault secret changes after the dry run (#962)", async () => {
    m.runCommand!.mockResolvedValue({
      ...DRY_RUN,
      created: [{ ...DRY_RUN.created[0]!, state: "reconcile" }],
    });
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await screen.findByTestId("spec-kit-export-claims");
    pickSecret("${vault:another}");
    expect(screen.getByTestId("spec-kit-export-clear")).toBeDisabled();
  });

  it("keeps Publish disabled when the vault secret did not resolve (#953)", async () => {
    m.runCommand!.mockResolvedValue({ ...DRY_RUN, credentialCheck: "unresolved" });
    await openFeature();
    pickSecret("${vault:typo}");
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-export-credential")).toHaveTextContent(
        /does not name a vault secret/,
      ),
    );
    expect(screen.getByTestId("spec-kit-export-publish")).toBeDisabled();
  });

  it("voids Publish when the vault secret changes after the dry run (#953)", async () => {
    m.runCommand!.mockResolvedValue(DRY_RUN);
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).toBeEnabled());
    pickSecret("${vault:another}");
    expect(screen.getByTestId("spec-kit-export-publish")).toBeDisabled();
    expect(screen.getByTestId("spec-kit-export-credential")).toHaveTextContent(/changed since/);
  });

  it("lists only the issues a run would create, and offers no Publish when there are none (#953)", async () => {
    m.runCommand!.mockResolvedValue({
      ...DRY_RUN,
      created: DRY_RUN.created.map((c, i) => ({ ...c, upserted: i === 0 })),
    });
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    const list = await screen.findByTestId("spec-kit-export-titles");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["[T02] Build B"]);
    cleanup();
    m.runCommand!.mockResolvedValue({
      ...DRY_RUN,
      created: DRY_RUN.created.map((c) => ({ ...c, upserted: true })),
    });
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() =>
      expect(screen.getByTestId("spec-kit-export-credential")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("spec-kit-export-publish")).toBeDisabled();
  });

  it("lists every issue title the dry run would create (#936)", async () => {
    m.runCommand!.mockResolvedValue(DRY_RUN);
    await openFeature();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    const list = await screen.findByTestId("spec-kit-export-titles");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["[T01] Build A", "[T02] Build B"]);
  });

  // #993 — choose a subset of tasks; Publish sends exactly the subset previewed.
  const AVAILABLE = [
    { taskId: "T01", title: "[T01] Build A" },
    { taskId: "T02", title: "[T02] Build B" },
    { taskId: "T03", title: "[T03] Build C (c.go:1)" },
  ];

  it("previews and publishes only the chosen tasks (#993)", async () => {
    m.runCommand!.mockResolvedValue({ ...DRY_RUN, available: AVAILABLE });
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    const picker = await screen.findByTestId("spec-kit-export-tasks");
    expect(
      within(picker)
        .getAllByRole("checkbox")
        .map((c) => (c as HTMLInputElement).checked),
    ).toEqual([true, true, true]);
    expect(picker).toHaveTextContent("[T03] Build C (c.go:1)");
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).toBeEnabled());
    fireEvent.click(screen.getByTestId("spec-kit-export-task-T02"));
    // The dry run covered every task; Publish waits for one of the new selection.
    expect(screen.getByTestId("spec-kit-export-publish")).toBeDisabled();
    expect(screen.getByTestId("spec-kit-export-selection-changed")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenLastCalledWith("p1", "speckit.taskstoissues", {
        featureSlug: "001-a",
        dryRun: true,
        secretRef: SECRET,
        taskIds: ["T01", "T03"],
      }),
    );
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).toBeEnabled());
    expect(screen.queryByTestId("spec-kit-export-selection-changed")).toBeNull();
    fireEvent.click(screen.getByTestId("spec-kit-export-publish"));
    await answerDialog("Publish");
    await waitFor(() =>
      expect(m.runCommand).toHaveBeenLastCalledWith("p1", "speckit.taskstoissues", {
        featureSlug: "001-a",
        dryRun: false,
        secretRef: SECRET,
        expectedPlan: { tasksVersion: 3, digest: "d".repeat(64) },
        taskIds: ["T01", "T03"],
      }),
    );
  });

  it("links the created issues in the success toast and the result card (#993)", async () => {
    m.runCommand!.mockResolvedValueOnce(DRY_RUN).mockResolvedValueOnce({
      ...DRY_RUN,
      message: "Exported 2 task(s) to me/sandbox.",
      created: [
        {
          taskId: "T01",
          issueNumber: 41,
          url: "https://github.com/me/sandbox/issues/41",
          state: "new",
        },
        { taskId: "T02", issueNumber: 42, url: "javascript:alert(1)", state: "new" },
      ],
    });
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).toBeEnabled());
    // A dry run's placeholders are never links.
    expect(toastSuccess).toHaveBeenLastCalledWith(DRY_RUN.message);
    expect(screen.queryByTestId("spec-kit-result-issue-links")).toBeNull();
    fireEvent.click(screen.getByTestId("spec-kit-export-publish"));
    await answerDialog("Publish");
    const links = await screen.findByTestId("spec-kit-result-issue-links");
    const anchors = within(links).getAllByRole("link");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toHaveAttribute("href", "https://github.com/me/sandbox/issues/41");
    expect(anchors[0]).toHaveTextContent("T01 #41");
    expect(toastSuccess).toHaveBeenLastCalledWith(
      "Exported 2 task(s) to me/sandbox.",
      expect.objectContaining({ description: expect.anything() }),
    );
  });

  it("names the repository and the issue count in the publish confirmation (#936)", async () => {
    m.runCommand!.mockResolvedValue(DRY_RUN);
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).toBeEnabled());
    fireEvent.click(screen.getByTestId("spec-kit-export-publish"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("me/sandbox");
    expect(dialog).toHaveTextContent("2 issues");
  });

  it("sends a failed command once: a 5xx is not retried (#936)", async () => {
    m.runCommand!.mockRejectedValue(
      new ApiError(501, "Exporting is not available", "SPECKIT_ISSUE_EXPORT_UNAVAILABLE"),
    );
    m.listFeatures!.mockResolvedValue({ features: [FEATURE] });
    m.listFeatureArtifacts!.mockResolvedValue({ feature: FEATURE, artifacts: [fa("spec.md")] });
    render(<SpecKitPage />, {
      wrapper: makeWrapper({ initialUser: WRITER, queryClient: createQueryClient() }),
    });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /001-a — Mark read/ })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("spec-kit-feature-select"), {
      target: { value: "001-a" },
    });
    fireEvent.click(await screen.findByTestId("spec-kit-export-preview"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 1500));
    expect(m.runCommand).toHaveBeenCalledTimes(1);
  });

  it("voids the dry run when tasks.md changes afterwards", async () => {
    m.runCommand!.mockResolvedValue(DRY_RUN);
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).not.toBeDisabled());
    m.listFeatureArtifacts!.mockResolvedValue({
      feature: FEATURE,
      artifacts: [fa("spec.md", "FR-1 mark entries read"), fa("tasks.md", "regenerated")],
    });
    fireEvent.click(screen.getByTestId("spec-kit-run-checklist"));
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).toBeDisabled());
  });

  it("voids the dry run when the user leaves the feature and returns", async () => {
    m.runCommand!.mockResolvedValue(DRY_RUN);
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).not.toBeDisabled());
    fireEvent.change(screen.getByTestId("spec-kit-feature-select"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("spec-kit-feature-select"), {
      target: { value: "001-a" },
    });
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).toBeDisabled());
  });

  it("offers no Delete while Spec Kit Mode is disabled", async () => {
    m.getEnabled!.mockResolvedValue({ enabled: false });
    m.listFiles!.mockResolvedValue({ enabled: false, artifacts: [artifact("spec.md", "S")] });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-root")).toBeInTheDocument());
    await flush();
    expect(screen.queryByTestId("spec-kit-delete-button")).not.toBeInTheDocument();
  });

  it("names the deleted file in the toast even if the selection moved meanwhile", async () => {
    let finish: () => void = () => undefined;
    m.deleteFeatureArtifact!.mockReturnValue(new Promise<void>((r) => (finish = r)));
    await openFeature();
    fireEvent.click(screen.getByTestId("spec-kit-feature-artifact-contracts/api.yaml"));
    fireEvent.click(screen.getByTestId("spec-kit-delete-button"));
    await answerDialog("Delete");
    await waitFor(() => expect(m.deleteFeatureArtifact).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("spec-kit-feature-artifact-plan.md"));
    finish();
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Deleted specs/001-a/contracts/api.yaml."),
    );
  });

  it("does not publish when the confirmation is declined", async () => {
    m.runCommand!.mockResolvedValue(DRY_RUN);
    await openFeature();
    pickSecret();
    fireEvent.click(screen.getByTestId("spec-kit-export-preview"));
    await waitFor(() => expect(screen.getByTestId("spec-kit-export-publish")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("spec-kit-export-publish"));
    await answerDialog("Cancel");
    await flush();
    expect(m.runCommand).toHaveBeenCalledTimes(1);
  });

  it("deletes a project artifact after confirmation", async () => {
    m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [artifact("spec.md", "S")] });
    m.deleteFile!.mockResolvedValue(undefined);
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    fireEvent.click(await screen.findByTestId("spec-kit-delete-button"));
    expect(m.deleteFile).not.toHaveBeenCalled();
    await answerDialog("Delete");
    await waitFor(() => expect(m.deleteFile).toHaveBeenCalledWith("p1", "spec.md"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Deleted spec.md."));
  });

  it("refetches the tree after a delete, so the deleted file disappears", async () => {
    m.listFiles!.mockResolvedValueOnce({ enabled: true, artifacts: [artifact("spec.md", "S")] });
    m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [] });
    m.deleteFile!.mockResolvedValue(undefined);
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    fireEvent.click(await screen.findByTestId("spec-kit-delete-button"));
    await answerDialog("Delete");
    await waitFor(() => expect(screen.getByTestId("spec-kit-empty-banner")).toBeInTheDocument());
  });

  it("does not delete when the confirmation is declined", async () => {
    m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [artifact("spec.md", "S")] });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    fireEvent.click(await screen.findByTestId("spec-kit-delete-button"));
    await answerDialog("Cancel");
    await flush();
    expect(m.deleteFile).not.toHaveBeenCalled();
  });

  it("deletes the viewed feature artifact", async () => {
    m.deleteFeatureArtifact!.mockResolvedValue(undefined);
    await openFeature();
    fireEvent.click(screen.getByTestId("spec-kit-feature-artifact-contracts/api.yaml"));
    fireEvent.click(screen.getByTestId("spec-kit-delete-button"));
    await answerDialog("Delete");
    await waitFor(() =>
      expect(m.deleteFeatureArtifact).toHaveBeenCalledWith("p1", "001-a", "contracts/api.yaml"),
    );
  });

  it("starts an analysis from the /speckit.implement handoff and opens it", async () => {
    m.listFiles!.mockResolvedValue({
      enabled: true,
      artifacts: [artifact("spec.md", "FR-1 project requirement")],
    });
    m.runCommand!.mockResolvedValue({
      message: "Spec Kit handoff ready with 3 artifact(s)",
      artifactName: null,
      artifact: {
        context: ["spec.md", "plan.md", "tasks.md"],
        orchestratorRoute: "/api/projects/p1/analyses",
      },
    });
    startAnalysis.mockResolvedValue({ id: "an_1" });
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-content")).toBeInTheDocument());
    typeAndRun("/speckit.implement");
    fireEvent.click(await screen.findByTestId("spec-kit-start-analysis"));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    const body = startAnalysis.mock.calls[0]![1] as { extraInstructions: string };
    expect(startAnalysis.mock.calls[0]![0]).toBe("p1");
    expect(body.extraInstructions).toContain("spec.md, plan.md, tasks.md");
    expect(body.extraInstructions).toContain("FR-1 project requirement");
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/projects/p1/analysis?analysisId=an_1"),
    );
  });

  it("hands off a feature's own spec.md when the implement ran in a feature", async () => {
    m.runCommand!.mockResolvedValue({
      message: "handoff",
      artifactName: null,
      artifact: {
        context: ["specs/001-a/spec.md"],
        orchestratorRoute: "/api/projects/p1/analyses",
      },
    });
    startAnalysis.mockResolvedValue({ id: "an_2" });
    await openFeature();
    typeAndRun("/speckit.implement");
    fireEvent.click(await screen.findByTestId("spec-kit-start-analysis"));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    expect(
      (startAnalysis.mock.calls[0]![1] as { extraInstructions: string }).extraInstructions,
    ).toContain("FR-1 mark entries read");
  });

  it("reports a failed analysis start with the user-safe toast", async () => {
    m.runCommand!.mockResolvedValue({
      message: "handoff",
      artifactName: null,
      artifact: {
        context: ["spec.md"],
        orchestratorRoute: "/api/projects/p1/analyses",
      },
    });
    startAnalysis.mockRejectedValue(new Error("db down"));
    render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
    await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
    typeAndRun("/speckit.implement");
    fireEvent.click(await screen.findByTestId("spec-kit-start-analysis"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The Spec Kit operation failed. Please try again."),
    );
    expect(routerPush).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // #945 — page UX found in walkthrough run 4
  // ───────────────────────────────────────────────────────────────────────────
  describe("#945", () => {
    const checklist = [
      "# Security checklist",
      "<!-- speckit-generated-checks: WyJDU1JGIl0= -->",
      "- [ ] CSRF on the new POST",
    ].join("\n");

    it("renders a checklist as Markdown and hides its base64 marker", async () => {
      m.listFiles!.mockResolvedValue({
        enabled: true,
        artifacts: [artifact("spec.md", checklist)],
      });
      render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
      const content = await screen.findByTestId("spec-kit-content");
      await waitFor(() => expect(content).toHaveAttribute("data-rendered", "markdown"));
      expect(within(content).getByRole("heading", { name: "Security checklist" })).toBeVisible();
      expect(within(content).getByRole("checkbox")).toBeInTheDocument();
      expect(content).not.toHaveTextContent("speckit-generated-checks");
      expect(content).not.toHaveTextContent("WyJDU1JGIl0=");
      // The editor still gets the marker: the next checklist run merges with it.
      fireEvent.click(screen.getByTestId("spec-kit-edit-button"));
      expect((screen.getByTestId("spec-kit-editor") as HTMLTextAreaElement).value).toContain(
        "speckit-generated-checks",
      );
    });

    it("shows the OpenAPI contract as wrapped text", async () => {
      await openFeature();
      fireEvent.click(screen.getByTestId("spec-kit-feature-artifact-contracts/api.yaml"));
      const content = await screen.findByTestId("spec-kit-content");
      await waitFor(() => expect(content.tagName).toBe("PRE"));
      expect(content.className).toContain("whitespace-pre-wrap");
    });

    it("tells a non-member they have no access instead of 'disabled'", async () => {
      m.getEnabled!.mockRejectedValue(new ApiError(404, "Project not found", "NOT_FOUND"));
      m.listFiles!.mockRejectedValue(new ApiError(404, "Project not found", "NOT_FOUND"));
      render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
      expect(await screen.findByTestId("spec-kit-no-access")).toHaveTextContent(
        /not a member of its workspace/,
      );
      expect(screen.queryByTestId("spec-kit-disabled-banner")).toBeNull();
      expect(screen.queryByTestId("spec-kit-toggle")).toBeNull();
    });

    it("still says 'disabled' when the API answers and the mode is off", async () => {
      m.getEnabled!.mockResolvedValue({ enabled: false });
      render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
      expect(await screen.findByTestId("spec-kit-disabled-banner")).toBeInTheDocument();
      expect(screen.queryByTestId("spec-kit-no-access")).toBeNull();
    });

    it("puts each disabled write's reason on a wrapper that receives hover", async () => {
      await openProjectArtifact(READER);
      for (const id of [
        "spec-kit-generate-constitution",
        "spec-kit-edit-button",
        "spec-kit-delete-button",
        "spec-kit-run-button",
      ]) {
        const wrapper = screen.getByTestId(id).closest("[data-hover-hint]");
        expect(wrapper, id).not.toBeNull();
        expect(wrapper, id).toHaveAttribute("title", "Requires project.update");
        expect(wrapper, id).toHaveAttribute("tabindex", "0");
      }
    });

    it("adds no wrapper when the control is usable", async () => {
      await openProjectArtifact(WRITER);
      for (const id of ["spec-kit-generate-constitution", "spec-kit-edit-button"]) {
        expect(screen.getByTestId(id).closest("[data-hover-hint]"), id).toBeNull();
      }
    });

    it("explains an unmet gate in the page's words, not the API's", async () => {
      m.runCommand!.mockRejectedValue(
        new ApiError(
          412,
          "plan.md is required — run /speckit.plan with this featureSlug first",
          "SPECKIT_GATE_UNMET",
          { required: "planGate" },
        ),
      );
      await openFeature();
      fireEvent.click(screen.getByTestId("spec-kit-run-checklist"));
      const error = await screen.findByTestId("spec-kit-error");
      expect(error).toHaveTextContent(
        "This feature has no plan.md yet. Run /speckit.plan on it first.",
      );
      expect(error).not.toHaveTextContent("featureSlug");
    });

    it("explains a refused save instead of printing the validation array", async () => {
      m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [artifact("spec.md", "S")] });
      m.putFile!.mockRejectedValue(
        new ApiError(
          400,
          JSON.stringify([
            { path: ["content"], message: "String must contain at most 200000 character(s)" },
          ]),
          "BAD_REQUEST",
        ),
      );
      render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
      fireEvent.click(await screen.findByTestId("spec-kit-edit-button"));
      fireEvent.click(screen.getByTestId("spec-kit-save-button"));
      const error = await screen.findByTestId("spec-kit-error");
      expect(error).toHaveTextContent(
        "The request was not accepted — content: String must contain at most 200000 character(s).",
      );
      expect(error).not.toHaveTextContent('"path"');
      // The draft is kept so nothing typed is lost.
      expect(screen.getByTestId("spec-kit-editor")).toBeInTheDocument();
    });

    it("keeps the selected feature in the URL and reopens it from there", async () => {
      await openFeature();
      expect(routerReplace).toHaveBeenLastCalledWith("/projects/p1/spec-kit?feature=001-a", {
        scroll: false,
      });
      cleanup();
      nav.search = "feature=001-a";
      render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
      await waitFor(() =>
        expect(screen.getByTestId("spec-kit-viewer-title")).toHaveTextContent(
          "specs/001-a/spec.md",
        ),
      );
    });

    it("re-reads the feature list when the tab is focused again", async () => {
      // The app's own client: no focus refetch and a 30 s stale time by default.
      render(<SpecKitPage />, {
        wrapper: makeWrapper({ initialUser: WRITER, queryClient: createQueryClient() }),
      });
      await waitFor(() => expect(m.listFeatures).toHaveBeenCalledTimes(1));
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await waitFor(() => expect(m.listFeatures).toHaveBeenCalledTimes(2));
      focusManager.setFocused(undefined);
    });

    it("keeps the handoff card across navigation, until analysis starts", async () => {
      m.runCommand!.mockResolvedValue({
        message: "handoff",
        artifactName: null,
        artifact: {
          context: ["spec.md", "plan.md"],
          orchestratorRoute: "/api/projects/p1/analyses",
        },
      });
      render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
      await waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeEnabled());
      typeAndRun("/speckit.implement");
      expect(await screen.findByTestId("spec-kit-handoff")).toHaveTextContent("spec.md, plan.md");
      cleanup();
      // Back on the page later: the card is still there.
      startAnalysis.mockResolvedValue({ id: "an_9" });
      render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
      expect(await screen.findByTestId("spec-kit-handoff")).toHaveTextContent("spec.md, plan.md");
      fireEvent.click(screen.getByTestId("spec-kit-start-analysis"));
      await waitFor(() => expect(routerPush).toHaveBeenCalled());
      cleanup();
      render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
      await waitFor(() => expect(screen.getByTestId("spec-kit-root")).toBeInTheDocument());
      await flush();
      expect(screen.queryByTestId("spec-kit-handoff")).toBeNull();
    });
  });
});
