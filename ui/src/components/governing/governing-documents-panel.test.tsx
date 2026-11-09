/**
 * #1871 — the workspace governing documents page.
 *
 * `fetch` is replaced by an in-memory fake of the #1869/#1870 routes, with the
 * server's own envelopes, status codes and role rule (a member gets 403 on a
 * write). A "reload" unmounts the panel and mounts it again over a fresh
 * QueryClient, so what it then shows came from the fake server's store, never
 * from the first mount's cache or an optimistic update. The QueryClient is the
 * app's own (`createQueryClient`: 30 s staleTime, no refetch on focus), so a
 * test sees the caching a user does (#1996); only its retries are off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  GOVERNING_EXTRACTION_STALE_MS,
  GOVERNING_PREVIEW_NOTE,
  findForbiddenComplianceClaims,
  MAX_DOCUMENT_BYTES,
  UPLOAD_EXTENSION_ALLOWLIST,
} from "@metis/shared";

const auth: { user: { id: string; role: string } | null } = {
  user: { id: "u-admin", role: "viewer" },
};
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }));

// #2109 — the Preview setting, switchable per test; on unless a test turns it off.
const preview = vi.hoisted(() => ({ on: true }));
vi.mock("@metis/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metis/shared")>();
  return {
    ...actual,
    get GOVERNING_PREVIEW() {
      return preview.on;
    },
  };
});

import {
  EXTRACTION_POLL_MS,
  GoverningDocumentsPanel,
  extractionStuckAt,
  formatEffectiveDate,
  isExtractionStuck,
  isExtractionUnsettled,
} from "./governing-documents-panel";
import {
  canManageGoverning,
  governingKeys,
  isGoverningUnavailable,
  useGoverningTabVisible,
} from "@/lib/governing-api";
import { ApiError } from "@/lib/api-client";
import { createQueryClient } from "@/lib/query-client";

const WS = "ws-1";

interface FakeRevision {
  id: string;
  documentId: string;
  revisionLabel: string;
  effectiveDate: string;
  mimeType: string;
  sizeBytes: number;
  indexState: string;
  extractionState: string;
  extractionError: string | null;
  extractionStartedAt: string | null;
  droppedUnverified: number;
  createdAt: string;
}
interface FakeRule {
  id: string;
  revisionId: string;
  controlId: string;
  summary: string;
  clauseRef: string;
  clauseExcerpt: string;
  editedAt: string | null;
  deletedAt: string | null;
}
interface FakeDoc {
  id: string;
  workspaceId: string;
  title: string;
  framework: string | null;
  currentRevisionId: string | null;
  createdAt: string;
}

/** The server's store and route shapes, kept across "reloads". */
class FakeServer {
  flagOn = true;
  members: { role: string; user: { id: string } }[] = [
    { role: "owner", user: { id: "u-owner" } },
    { role: "admin", user: { id: "u-admin" } },
    { role: "member", user: { id: "u-member" } },
  ];
  docs: FakeDoc[] = [];
  revisions: FakeRevision[] = [];
  rules: FakeRule[] = [];
  requests: { method: string; path: string; body: unknown }[] = [];
  /**
   * The real route answers 202 and starts the run in the background, so its
   * `running` can commit after the response. With this on, the start waits in
   * `pendingStarts` until the test runs it.
   */
  deferRetryStart = false;
  pendingStarts: (() => void)[] = [];
  private seq = 0;

  nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  seedDocument(opts: {
    title: string;
    framework?: string | null;
    extractionState?: string;
    extractionError?: string | null;
    droppedUnverified?: number;
    rules?: Array<Pick<FakeRule, "controlId" | "summary" | "clauseRef" | "clauseExcerpt">>;
    revisionLabel?: string;
    extractionStartedAt?: string | null;
    createdAt?: string;
  }): { doc: FakeDoc; revision: FakeRevision } {
    const doc: FakeDoc = {
      id: this.nextId("doc"),
      workspaceId: WS,
      title: opts.title,
      framework: opts.framework ?? null,
      currentRevisionId: null,
      createdAt: new Date().toISOString(),
    };
    this.docs.unshift(doc);
    const revision = this.addRevision(doc, {
      revisionLabel: opts.revisionLabel ?? "v1",
      effectiveDate: "2026-01-15T00:00:00.000Z",
      extractionState: opts.extractionState ?? "done",
      extractionError: opts.extractionError ?? null,
      droppedUnverified: opts.droppedUnverified ?? 0,
      extractionStartedAt: opts.extractionStartedAt ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
    this.addRules(revision, opts.rules ?? []);
    return { doc, revision };
  }

  addRules(
    revision: FakeRevision,
    rules: Array<Pick<FakeRule, "controlId" | "summary" | "clauseRef" | "clauseExcerpt">>,
  ) {
    for (const r of rules) {
      this.rules.push({
        ...r,
        id: this.nextId("rule"),
        revisionId: revision.id,
        editedAt: null,
        deletedAt: null,
      });
    }
  }

  addRevision(
    doc: FakeDoc,
    fields: Pick<
      FakeRevision,
      | "revisionLabel"
      | "effectiveDate"
      | "extractionState"
      | "extractionError"
      | "droppedUnverified"
    > &
      Partial<Pick<FakeRevision, "extractionStartedAt" | "createdAt">>,
  ): FakeRevision {
    const revision: FakeRevision = {
      id: this.nextId("rev"),
      documentId: doc.id,
      mimeType: "text/markdown",
      sizeBytes: 10,
      indexState: "indexed",
      extractionStartedAt: null,
      createdAt: new Date().toISOString(),
      ...fields,
    };
    this.revisions.unshift(revision);
    doc.currentRevisionId = revision.id;
    return revision;
  }

  private role(): string | undefined {
    if (!auth.user) return undefined;
    if (auth.user.role === "admin") return "owner";
    return this.members.find((m) => m.user.id === auth.user!.id)?.role;
  }

  private pub(rev: FakeRevision, doc: FakeDoc) {
    return { ...rev, isCurrent: rev.id === doc.currentRevisionId };
  }

  handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      init?.body instanceof FormData
        ? Object.fromEntries(init.body.entries())
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined;
    this.requests.push({ method, path: url.pathname, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify({ success: true, data }), { status });
    const err = (status: number, code: string, message: string) =>
      new Response(JSON.stringify({ success: false, error: { code, message } }), { status });

    const parts = url.pathname.replace(/^\/api\//, "").split("/");
    // /workspaces/:id
    if (parts.length === 2 && parts[0] === "workspaces" && method === "GET") {
      return json(200, { id: WS, members: this.members });
    }
    const [, workspaceId, area, ...rest] = parts;
    if (workspaceId !== WS) return err(404, "NOT_FOUND", "Workspace not found");
    if (!this.flagOn) return err(404, "NOT_FOUND", "Not found");
    const role = this.role();
    if (!role) return err(404, "NOT_FOUND", "Workspace not found");
    const isAdmin = role === "owner" || role === "admin";
    if (method !== "GET" && !isAdmin) {
      return err(403, "FORBIDDEN", "Requires workspace role admin or higher");
    }

    if (area === "governing-rules" && method === "PATCH") {
      const rule = this.rules.find((r) => r.id === rest[0] && !r.deletedAt);
      if (!rule) return err(404, "NOT_FOUND", "Governing rule not found");
      const patch = body as { summary?: string; controlId?: string; deleted?: true };
      if (patch.deleted) rule.deletedAt = new Date().toISOString();
      if (patch.summary) rule.summary = patch.summary;
      if (patch.controlId) rule.controlId = patch.controlId;
      rule.editedAt = new Date().toISOString();
      return json(200, { rule, changed: true });
    }
    if (area !== "governing-documents") return err(404, "NOT_FOUND", "Not found");

    if (rest.length === 0 && method === "GET") {
      return json(200, {
        documents: this.docs.map((doc) => {
          const rev = this.revisions.find((r) => r.id === doc.currentRevisionId);
          return { ...doc, currentRevision: rev ? this.pub(rev, doc) : null };
        }),
      });
    }
    if (rest.length === 0 && method === "POST") {
      const form = body as Record<string, string>;
      const doc: FakeDoc = {
        id: this.nextId("doc"),
        workspaceId: WS,
        title: form.title,
        framework: form.framework ?? null,
        currentRevisionId: null,
        createdAt: new Date().toISOString(),
      };
      this.docs.unshift(doc);
      const rev = this.addRevision(doc, {
        revisionLabel: form.revisionLabel,
        effectiveDate: new Date(form.effectiveDate).toISOString(),
        extractionState: "pending",
        extractionError: null,
        droppedUnverified: 0,
      });
      return json(201, { documentId: doc.id, revisionId: rev.id });
    }
    const doc = this.docs.find((d) => d.id === rest[0]);
    if (!doc) return err(404, "NOT_FOUND", "Governing document not found");
    if (rest.length === 1 && method === "GET") {
      return json(200, {
        document: {
          ...doc,
          revisions: this.revisions
            .filter((r) => r.documentId === doc.id)
            .map((r) => this.pub(r, doc)),
        },
      });
    }
    if (rest[1] === "rules" && method === "GET") {
      const wanted = url.searchParams.get("revisionId") ?? doc.currentRevisionId;
      const rev = this.revisions.find((r) => r.id === wanted && r.documentId === doc.id);
      if (!rev) return err(404, "NOT_FOUND", "Governing document not found");
      return json(200, {
        documentId: doc.id,
        revision: this.pub(rev, doc),
        rules: this.rules.filter((r) => r.revisionId === rev.id && !r.deletedAt),
      });
    }
    if (rest[1] === "revisions" && rest.length === 2 && method === "POST") {
      const form = body as Record<string, string>;
      const rev = this.addRevision(doc, {
        revisionLabel: form.revisionLabel,
        effectiveDate: new Date(form.effectiveDate).toISOString(),
        extractionState: "pending",
        extractionError: null,
        droppedUnverified: 0,
      });
      return json(201, { documentId: doc.id, revisionId: rev.id });
    }
    if (rest[3] === "rule-extraction" && method === "POST") {
      const rev = this.revisions.find((r) => r.id === rest[2]);
      if (!rev) return err(404, "NOT_FOUND", "Governing revision not found");
      // The route's `isExtractionStartable`: pending, failed, or a stale run.
      const freshRun =
        rev.extractionState === "running" &&
        rev.extractionStartedAt !== null &&
        Date.parse(rev.extractionStartedAt) >= Date.now() - GOVERNING_EXTRACTION_STALE_MS;
      if (rev.extractionState === "done" || freshRun) {
        return err(409, "EXTRACTION_NOT_RETRYABLE", "Not retryable");
      }
      const start = () => {
        rev.extractionState = "running";
        rev.extractionError = null;
        rev.extractionStartedAt = new Date().toISOString();
      };
      if (this.deferRetryStart) this.pendingStarts.push(start);
      else start();
      return json(202, { documentId: doc.id, revisionId: rev.id, scheduled: true });
    }
    return err(404, "NOT_FOUND", "Not found");
  };
}

let server: FakeServer;

/** The app's QueryClient, retries off; returned so a test can read its cache. */
function mount(): QueryClient {
  const qc = createQueryClient();
  const defaults = qc.getDefaultOptions();
  qc.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
  render(
    <QueryClientProvider client={qc}>
      <GoverningDocumentsPanel workspaceId={WS} />
    </QueryClientProvider>,
  );
  return qc;
}

/** A page reload: nothing survives but the server's store. */
function reload() {
  cleanup();
  return mount();
}

const POLICY_RULES = [
  {
    controlId: "AC-2",
    summary: "Review user access quarterly",
    clauseRef: "§4.3",
    clauseExcerpt: "Access rights shall be reviewed every quarter by the system owner.",
  },
  {
    controlId: "AC-7",
    summary: "Lock accounts after five failed sign-ins",
    clauseRef: "§4.7",
    clauseExcerpt: "An account shall be locked after five consecutive failed sign-in attempts.",
  },
];

beforeEach(() => {
  server = new FakeServer();
  auth.user = { id: "u-admin", role: "viewer" };
  vi.stubGlobal("fetch", vi.fn(server.handle));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  preview.on = true;
});

describe("GoverningDocumentsPanel — the Preview mark (#2109)", () => {
  it("shows the Preview badge and its note on the tab, with documents or without", async () => {
    server.seedDocument({ title: "Policy", rules: POLICY_RULES });
    mount();
    await screen.findByRole("table", { name: "Governing documents" });
    const note = screen.getByTestId("governing-preview");
    expect(note).toHaveAttribute("role", "note");
    expect(within(note).getByText("Preview")).toBeInTheDocument();
    expect(note).toHaveTextContent(GOVERNING_PREVIEW_NOTE);
    expect(findForbiddenComplianceClaims(note.textContent ?? "")).toEqual([]);

    server.docs = [];
    reload();
    await screen.findByText("No governing documents yet");
    expect(screen.getByTestId("governing-preview")).toHaveTextContent(GOVERNING_PREVIEW_NOTE);
  });

  it("shows no Preview mark when the setting is off", async () => {
    preview.on = false;
    server.seedDocument({ title: "Policy", rules: POLICY_RULES });
    mount();
    await screen.findByRole("table", { name: "Governing documents" });
    expect(screen.queryByTestId("governing-preview")).toBeNull();
    expect(screen.queryByText(GOVERNING_PREVIEW_NOTE)).toBeNull();
  });

  it("shows no Preview mark when the workspace has governing documents turned off", async () => {
    server.flagOn = false;
    mount();
    await screen.findByText("Governing documents are not available");
    expect(screen.queryByTestId("governing-preview")).toBeNull();
  });
});

/** Run the list's next poll: the panel re-reads every {@link EXTRACTION_POLL_MS}. */
async function nextPoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(EXTRACTION_POLL_MS);
  });
}

describe("pure helpers", () => {
  it("isExtractionUnsettled is true only for pending and running", () => {
    expect(isExtractionUnsettled("pending")).toBe(true);
    expect(isExtractionUnsettled("running")).toBe(true);
    expect(isExtractionUnsettled("done")).toBe(false);
    expect(isExtractionUnsettled("failed")).toBe(false);
    expect(isExtractionUnsettled(undefined)).toBe(false);
  });

  it("isExtractionStuck: pending or running past the stale bound, or running with no start time", () => {
    const now = Date.parse("2026-11-07T12:00:00.000Z");
    const stale = new Date(now - GOVERNING_EXTRACTION_STALE_MS - 1).toISOString();
    const fresh = new Date(now - GOVERNING_EXTRACTION_STALE_MS + 60_000).toISOString();
    const rev = (extractionState: string, extractionStartedAt: string | null, createdAt: string) =>
      isExtractionStuck({ extractionState, extractionStartedAt, createdAt } as never, now);
    expect(rev("pending", null, stale)).toBe(true);
    expect(rev("pending", null, fresh)).toBe(false);
    expect(rev("running", stale, fresh)).toBe(true);
    expect(rev("running", fresh, stale)).toBe(false);
    expect(rev("running", null, fresh)).toBe(true);
    expect(rev("failed", stale, stale)).toBe(false);
    expect(rev("done", stale, stale)).toBe(false);
  });

  it("extractionStuckAt: when an unsettled revision becomes stuck; null for a settled one", () => {
    const at = "2026-11-07T12:00:00.000Z";
    const later = "2026-11-07T12:30:00.000Z";
    const rev = (extractionState: string, extractionStartedAt: string | null) =>
      extractionStuckAt({ extractionState, extractionStartedAt, createdAt: at } as never);
    expect(rev("pending", later)).toBe(Date.parse(at) + GOVERNING_EXTRACTION_STALE_MS);
    expect(rev("running", later)).toBe(Date.parse(later) + GOVERNING_EXTRACTION_STALE_MS);
    expect(rev("running", null)).toBe(-Infinity);
    expect(rev("done", later)).toBeNull();
    expect(rev("failed", later)).toBeNull();
  });

  it("formatEffectiveDate reads the date in UTC and passes an unreadable value through", () => {
    expect(formatEffectiveDate("2026-01-15T00:00:00.000Z")).toBe("2026-01-15");
    expect(formatEffectiveDate("not a date")).toBe("not a date");
  });

  it("canManageGoverning: owner, admin and a deployment admin; never a member or no user", () => {
    const members = [
      { role: "owner", user: { id: "o" } },
      { role: "admin", user: { id: "a" } },
      { role: "member", user: { id: "m" } },
    ];
    expect(canManageGoverning(members, { id: "o", role: "viewer" })).toBe(true);
    expect(canManageGoverning(members, { id: "a", role: "viewer" })).toBe(true);
    expect(canManageGoverning(members, { id: "m", role: "viewer" })).toBe(false);
    expect(canManageGoverning(members, { id: "stranger", role: "viewer" })).toBe(false);
    expect(canManageGoverning(undefined, { id: "sys", role: "admin" })).toBe(true);
    expect(canManageGoverning(members, null)).toBe(false);
  });

  it("isGoverningUnavailable is a 404 ApiError only", () => {
    expect(isGoverningUnavailable(new ApiError(404, "Not found", "NOT_FOUND"))).toBe(true);
    expect(isGoverningUnavailable(new ApiError(500, "boom"))).toBe(false);
    expect(isGoverningUnavailable(new Error("x"))).toBe(false);
  });
});

describe("useGoverningTabVisible — the workspace nav's Governing documents tab", () => {
  function renderTabHook(workspaceId: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return renderHook(() => useGoverningTabVisible(workspaceId), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
  }

  it("shows once the list route answers", async () => {
    const { result } = renderTabHook(WS);
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("stays hidden when the server reports the flag off (404)", async () => {
    server.flagOn = false;
    const { result } = renderTabHook(WS);
    await waitFor(() =>
      expect(server.requests.some((r) => r.path.endsWith("/governing-documents"))).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe(false);
  });

  it("asks nothing without a workspace id", async () => {
    const { result } = renderTabHook("");
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe(false);
    expect(server.requests).toHaveLength(0);
  });
});

describe("GoverningDocumentsPanel", () => {
  it("uploads through the dialog, and the new document is listed after a reload", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Upload document" }));
    const dialog = await screen.findByRole("dialog");
    const file = new File(["# Access policy\nAccess rights shall be reviewed."], "policy.md", {
      type: "text/markdown",
    });
    await user.upload(within(dialog).getByLabelText("File"), file);
    await user.type(within(dialog).getByLabelText("Title"), "Access Control Policy");
    await user.type(within(dialog).getByLabelText("Framework (optional)"), "ISO 27001");
    await user.type(within(dialog).getByLabelText("Revision label"), "v1");
    await user.type(within(dialog).getByLabelText("Effective date"), "2026-03-01");
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const upload = server.requests.find(
      (r) => r.method === "POST" && r.path === `/api/workspaces/${WS}/governing-documents`,
    );
    expect(upload?.body).toMatchObject({
      title: "Access Control Policy",
      framework: "ISO 27001",
      revisionLabel: "v1",
      effectiveDate: "2026-03-01",
    });
    expect((upload?.body as { file: File }).file.name).toBe("policy.md");

    reload();
    const table = await screen.findByRole("table", { name: "Governing documents" });
    const row = within(table).getByRole("button", { name: "Access Control Policy" }).closest("tr")!;
    expect(within(row).getByText("ISO 27001")).toBeInTheDocument();
    expect(within(row).getByText("v1")).toBeInTheDocument();
    expect(within(row).getByText("2026-03-01")).toBeInTheDocument();
    expect(within(row).getByText("pending")).toBeInTheDocument();
  });

  it("refuses an oversized file with the project upload's message, before any request", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Upload document" }));
    const dialog = await screen.findByRole("dialog");
    const big = new File(["x"], "big.md", { type: "text/markdown" });
    Object.defineProperty(big, "size", { value: MAX_DOCUMENT_BYTES + 1 });
    await user.upload(within(dialog).getByLabelText("File"), big);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      `File exceeds the ${(MAX_DOCUMENT_BYTES / 1024 / 1024).toFixed(0)} MB cap`,
    );
    await user.type(within(dialog).getByLabelText("Title"), "T");
    await user.type(within(dialog).getByLabelText("Revision label"), "v1");
    await user.type(within(dialog).getByLabelText("Effective date"), "2026-03-01");
    expect(within(dialog).getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(server.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("shows the server's error inside the dialog when the upload is refused", async () => {
    const user = userEvent.setup();
    const handle = server.handle;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(
              JSON.stringify({
                success: false,
                error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "File type is not allowed" },
              }),
              { status: 415 },
            )
          : handle(input, init),
      ),
    );
    mount();
    await user.click(await screen.findByRole("button", { name: "Upload document" }));
    const dialog = await screen.findByRole("dialog");
    await user.upload(
      within(dialog).getByLabelText("File"),
      new File(["a"], "a.md", { type: "text/markdown" }),
    );
    await user.type(within(dialog).getByLabelText("Title"), "T");
    await user.type(within(dialog).getByLabelText("Revision label"), "v1");
    await user.type(within(dialog).getByLabelText("Effective date"), "2026-03-01");
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "File type is not allowed (UNSUPPORTED_MEDIA_TYPE)",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("edits a rule summary, and the edit is still there after a reload", async () => {
    const user = userEvent.setup();
    server.seedDocument({ title: "Access Control Policy", rules: POLICY_RULES });
    mount();
    await user.click(await screen.findByRole("button", { name: "Access Control Policy" }));
    const rules = await screen.findByRole("region", { name: "Rules of Access Control Policy" });
    await user.click(within(rules).getByRole("button", { name: "Edit AC-2" }));
    const summary = within(rules).getByLabelText("Summary");
    await user.clear(summary);
    await user.type(summary, "Review every user's access each quarter");
    await user.click(within(rules).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(within(rules).queryByRole("form", { name: "Edit rule AC-2" })).toBeNull(),
    );

    const patch = server.requests.find((r) => r.method === "PATCH");
    expect(patch?.body).toEqual({ summary: "Review every user's access each quarter" });

    reload();
    await user.click(await screen.findByRole("button", { name: "Access Control Policy" }));
    const after = await screen.findByRole("region", { name: "Rules of Access Control Policy" });
    expect(within(after).getByText("Review every user's access each quarter")).toBeInTheDocument();
    expect(within(after).queryByText("Review user access quarterly")).toBeNull();
  });

  it("an unchanged edit sends nothing; a changed control id sends only that field", async () => {
    const user = userEvent.setup();
    server.seedDocument({ title: "Policy", rules: POLICY_RULES });
    mount();
    await user.click(await screen.findByRole("button", { name: "Policy" }));
    const rules = await screen.findByRole("region", { name: "Rules of Policy" });
    await user.click(within(rules).getByRole("button", { name: "Edit AC-2" }));
    await user.click(within(rules).getByRole("button", { name: "Save" }));
    expect(server.requests.some((r) => r.method === "PATCH")).toBe(false);

    await user.click(within(rules).getByRole("button", { name: "Edit AC-2" }));
    const control = within(rules).getByLabelText("Control id");
    await user.clear(control);
    await user.type(control, "AC-2.1");
    await user.click(within(rules).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.requests.find((r) => r.method === "PATCH")?.body).toEqual({
        controlId: "AC-2.1",
      }),
    );
  });

  it("removes a rule after confirmation, and it stays gone after a reload", async () => {
    const user = userEvent.setup();
    server.seedDocument({ title: "Policy", rules: POLICY_RULES });
    mount();
    await user.click(await screen.findByRole("button", { name: "Policy" }));
    const rules = await screen.findByRole("region", { name: "Rules of Policy" });
    await user.click(within(rules).getByRole("button", { name: "Remove AC-7" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(rules).queryByText("AC-7")).toBeNull());
    expect(server.requests.find((r) => r.method === "PATCH")?.body).toEqual({ deleted: true });

    reload();
    await user.click(await screen.findByRole("button", { name: "Policy" }));
    const after = await screen.findByRole("region", { name: "Rules of Policy" });
    expect(within(after).getByText("AC-2")).toBeInTheDocument();
    expect(within(after).queryByText("AC-7")).toBeNull();
  });

  it("expands a rule to show its verbatim clause excerpt", async () => {
    const user = userEvent.setup();
    server.seedDocument({ title: "Policy", rules: POLICY_RULES, droppedUnverified: 1 });
    mount();
    const table = await screen.findByRole("table", { name: "Governing documents" });
    const row = within(table).getByRole("button", { name: "Policy" }).closest("tr")!;
    // Rule count (2) and dropped-unverified (1) from the server.
    await waitFor(() => expect(within(row).getByText("2")).toBeInTheDocument());
    expect(within(row).getByText("1")).toBeInTheDocument();

    await user.click(within(table).getByRole("button", { name: "Policy" }));
    const rules = await screen.findByRole("region", { name: "Rules of Policy" });
    expect(within(rules).getByRole("note")).toHaveTextContent("Rules are used as extracted");
    const toggle = within(rules).getByRole("button", { name: "Show clause for AC-2" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(rules).queryByLabelText("Clause excerpt for AC-2")).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(rules).getByLabelText("Clause excerpt for AC-2")).toHaveTextContent(
      POLICY_RULES[0].clauseExcerpt,
    );
    await user.click(toggle);
    expect(within(rules).queryByLabelText("Clause excerpt for AC-2")).toBeNull();
  });

  it("a workspace member sees the rules but no Upload, Edit, Remove or revision controls", async () => {
    auth.user = { id: "u-member", role: "viewer" };
    const user = userEvent.setup();
    server.seedDocument({
      title: "Policy",
      rules: POLICY_RULES,
    });
    server.seedDocument({
      title: "Broken policy",
      extractionState: "failed",
      extractionError: "Provider timed out",
    });
    const qc = mount();
    const table = await screen.findByRole("table", { name: "Governing documents" });
    // The workspace's members have loaded (the role decision is made on them).
    await waitFor(() => expect(qc.getQueryState(["workspace", WS])?.status).toBe("success"));
    await user.click(within(table).getByRole("button", { name: "Policy" }));
    const rules = await screen.findByRole("region", { name: "Rules of Policy" });
    expect(within(rules).getByText("Review user access quarterly")).toBeInTheDocument();
    expect(within(rules).getByRole("note")).toHaveTextContent("A workspace admin can correct");

    expect(screen.queryByRole("button", { name: "Upload document" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^New revision / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Retry extraction / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Re-upload / })).toBeNull();
    expect(screen.getByText("Provider timed out")).toBeInTheDocument();
    expect(
      screen.getByText("A workspace admin can retry it or upload a new revision."),
    ).toBeInTheDocument();
  });

  it("a failed extraction shows its error, and Retry re-schedules it", async () => {
    const user = userEvent.setup();
    const { doc, revision } = server.seedDocument({
      title: "Broken policy",
      extractionState: "failed",
      extractionError: "Provider timed out",
    });
    mount();
    expect(await screen.findByText("Provider timed out")).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: "Retry extraction of Broken policy" }),
    );
    await waitFor(() =>
      expect(
        server.requests.some(
          (r) =>
            r.method === "POST" &&
            r.path ===
              `/api/workspaces/${WS}/governing-documents/${doc.id}/revisions/${revision.id}/rule-extraction`,
        ),
      ).toBe(true),
    );
    // The revision reads running at once, and Retry is gone.
    await waitFor(() => expect(screen.queryByText("Provider timed out")).toBeNull());
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Retry extraction / })).toBeNull();
  });

  it("a failed retry shows the server's reason", async () => {
    const user = userEvent.setup();
    server.seedDocument({
      title: "Broken policy",
      extractionState: "failed",
      extractionError: "Provider timed out",
    });
    const handle = server.handle;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/rule-extraction")
          ? new Response(
              JSON.stringify({
                success: false,
                error: { code: "EXTRACTION_NOT_RETRYABLE", message: "Still running" },
              }),
              { status: 409 },
            )
          : handle(input, init),
      ),
    );
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Retry extraction of Broken policy" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Still running (EXTRACTION_NOT_RETRYABLE)",
    );
  });

  it("a failed extraction offers Re-upload, which posts a new revision of that document", async () => {
    const user = userEvent.setup();
    const { doc } = server.seedDocument({
      title: "Broken policy",
      extractionState: "failed",
      extractionError: "Provider timed out",
    });
    mount();
    await user.click(await screen.findByRole("button", { name: "Re-upload Broken policy" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("New revision of Broken policy");
    expect(within(dialog).queryByLabelText("Title")).toBeNull();
    await user.upload(
      within(dialog).getByLabelText("File"),
      new File(["policy v2"], "policy.txt", { type: "text/plain" }),
    );
    await user.type(within(dialog).getByLabelText("Revision label"), "v2");
    await user.type(within(dialog).getByLabelText("Effective date"), "2026-04-01");
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      server.requests.find(
        (r) =>
          r.method === "POST" &&
          r.path === `/api/workspaces/${WS}/governing-documents/${doc.id}/revisions`,
      )?.body,
    ).toMatchObject({ revisionLabel: "v2", effectiveDate: "2026-04-01" });

    reload();
    const table = await screen.findByRole("table", { name: "Governing documents" });
    const row = within(table).getByRole("button", { name: "Broken policy" }).closest("tr")!;
    expect(within(row).getByText("v2")).toBeInTheDocument();
    expect(within(row).queryByText("Provider timed out")).toBeNull();
  });

  it("lets a reader pick an earlier revision's rules", async () => {
    const user = userEvent.setup();
    const { doc, revision: v1 } = server.seedDocument({ title: "Policy", rules: POLICY_RULES });
    const v2 = server.addRevision(doc, {
      revisionLabel: "v2",
      effectiveDate: "2026-06-01T00:00:00.000Z",
      extractionState: "done",
      extractionError: null,
      droppedUnverified: 0,
    });
    server.rules.push({
      id: "rule-v2",
      revisionId: v2.id,
      controlId: "AC-9",
      summary: "New v2 rule",
      clauseRef: "§9",
      clauseExcerpt: "A new clause.",
      editedAt: null,
      deletedAt: null,
    });
    mount();
    await user.click(await screen.findByRole("button", { name: "Policy" }));
    const rules = await screen.findByRole("region", { name: "Rules of Policy" });
    expect(await within(rules).findByText("New v2 rule")).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText("Revision"), v1.id);
    expect(await screen.findByText("Review user access quarterly")).toBeInTheDocument();
    expect(screen.queryByText("New v2 rule")).toBeNull();
    expect(server.requests.some((r) => r.path.endsWith("/rules") && r.method === "GET")).toBe(true);
  });

  it("#1996 — a poll that sees the extraction finish re-reads the rule count and the open rules table", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { revision } = server.seedDocument({
      title: "Policy",
      extractionState: "running",
      extractionStartedAt: new Date().toISOString(),
    });
    mount();
    await user.click(await screen.findByRole("button", { name: "Policy" }));
    const rules = await screen.findByRole("region", { name: "Rules of Policy" });
    expect(
      within(rules).getByText("No rules yet — extraction has not finished."),
    ).toBeInTheDocument();

    // The run finishes on the server; the page learns of it only by its poll.
    revision.extractionState = "done";
    server.addRules(revision, POLICY_RULES);
    await nextPoll();

    const table = screen.getByRole("table", { name: "Governing documents" });
    const row = within(table).getByRole("button", { name: "Policy" }).closest("tr")!;
    await waitFor(() => expect(within(row).getByText("done")).toBeInTheDocument());
    expect(await within(rules).findByText("Review user access quarterly")).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText("2")).toBeInTheDocument());
  });

  it("#1996 — a retry reads running at once even when the server's state change lands after the 202", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { revision } = server.seedDocument({
      title: "Broken policy",
      extractionState: "failed",
      extractionError: "Provider timed out",
    });
    server.deferRetryStart = true;
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Retry extraction of Broken policy" }),
    );
    // The 202 is in, the server still says failed: the row says running, so a
    // second click (which the route would refuse with 409) is not offered.
    expect(await screen.findByText("running")).toBeInTheDocument();
    expect(screen.queryByText("Provider timed out")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Retry extraction / })).toBeNull();
    expect(revision.extractionState).toBe("failed");

    // The run's start commits and then finishes; the poll picks both up.
    server.pendingStarts.forEach((start) => start());
    await nextPoll();
    revision.extractionState = "done";
    server.addRules(revision, POLICY_RULES);
    await nextPoll();
    const row = screen.getByRole("button", { name: "Broken policy" }).closest("tr")!;
    await waitFor(() => expect(within(row).getByText("done")).toBeInTheDocument());
    await waitFor(() => expect(within(row).getByText("2")).toBeInTheDocument());
    expect(server.requests.filter((r) => r.path.endsWith("/rule-extraction"))).toHaveLength(1);
  });

  it("#1996 — a revision stuck running past the stale bound offers Retry, and the route takes it", async () => {
    const user = userEvent.setup();
    const deadStart = new Date(Date.now() - GOVERNING_EXTRACTION_STALE_MS - 60_000).toISOString();
    const { revision } = server.seedDocument({
      title: "Stuck policy",
      extractionState: "running",
      extractionStartedAt: deadStart,
    });
    server.seedDocument({
      title: "Busy policy",
      extractionState: "running",
      extractionStartedAt: new Date().toISOString(),
    });
    mount();
    const retry = await screen.findByRole("button", { name: "Retry extraction of Stuck policy" });
    expect(screen.getByText(/has not finished in 60 minutes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry extraction of Busy policy" })).toBeNull();
    await user.click(retry);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry extraction of Stuck policy" })).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(revision.extractionStartedAt).not.toBe(deadStart);
  });

  it("#1996 — a revision left pending past the stale bound offers Retry; a fresh upload does not", async () => {
    const long = new Date(Date.now() - GOVERNING_EXTRACTION_STALE_MS - 60_000).toISOString();
    server.seedDocument({ title: "Orphaned policy", extractionState: "pending", createdAt: long });
    server.seedDocument({ title: "New policy", extractionState: "pending" });
    mount();
    expect(
      await screen.findByRole("button", { name: "Retry extraction of Orphaned policy" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/has not finished in 60 minutes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry extraction of New policy" })).toBeNull();
  });

  it("#2002 — a revision that becomes stuck while the page is open gets Retry without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 8 s short of the bound: every poll of it returns the same data, so only
    // the clock crossing the bound can change what the row shows.
    server.seedDocument({
      title: "Slow policy",
      extractionState: "running",
      extractionStartedAt: new Date(
        Date.now() - GOVERNING_EXTRACTION_STALE_MS + 8_000,
      ).toISOString(),
    });
    // A second one crosses later, after the first crossing's re-render.
    server.seedDocument({
      title: "Slower policy",
      extractionState: "pending",
      createdAt: new Date(Date.now() - GOVERNING_EXTRACTION_STALE_MS + 28_000).toISOString(),
    });
    mount();
    await screen.findByRole("table", { name: "Governing documents" });
    expect(screen.queryByRole("button", { name: /^Retry extraction / })).toBeNull();

    for (let i = 0; i < 4; i += 1) await nextPoll();
    expect(
      await screen.findByRole("button", { name: "Retry extraction of Slow policy" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/has not finished in 60 minutes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry extraction of Slower policy" })).toBeNull();

    for (let i = 0; i < 2; i += 1) await nextPoll();
    expect(
      await screen.findByRole("button", { name: "Retry extraction of Slower policy" }),
    ).toBeInTheDocument();
  });

  it("#2002 — a list poll in flight when a retry's 202 lands cannot put back failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { revision } = server.seedDocument({
      title: "Broken policy",
      extractionState: "failed",
      extractionError: "Provider timed out",
    });
    // Another document's run keeps the list polling.
    server.seedDocument({
      title: "Busy policy",
      extractionState: "running",
      extractionStartedAt: new Date().toISOString(),
    });
    server.deferRetryStart = true;
    // The next list read is answered at once (Broken policy still failed) but
    // delivered only when the test releases it.
    let holdList = false;
    let release: () => void = () => {};
    const isListRead = (input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET" &&
      new URL(String(input), "http://localhost").pathname ===
        `/api/workspaces/${WS}/governing-documents`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await server.handle(input, init);
        if (holdList && isListRead(input, init)) {
          holdList = false;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return res;
      }),
    );
    const qc = mount();
    const retry = await screen.findByRole("button", { name: "Retry extraction of Broken policy" });

    holdList = true;
    const listReads = () =>
      server.requests.filter((r) => isListRead(`http://localhost${r.path}`, { method: r.method }));
    const readsBefore = listReads().length;
    await nextPoll();
    expect(listReads()).toHaveLength(readsBefore + 1);
    expect(holdList).toBe(false);

    await user.click(retry);
    const row = screen.getByRole("button", { name: "Broken policy" }).closest("tr")!;
    expect(await within(row).findByText("running")).toBeInTheDocument();

    // The poll that read `failed` before the 202 now answers.
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => expect(qc.isFetching({ queryKey: governingKeys.list(WS) })).toBe(0));
    expect(within(row).getByText("running")).toBeInTheDocument();
    expect(within(row).queryByText("Provider timed out")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry extraction of Broken policy" })).toBeNull();
    expect(revision.extractionState).toBe("failed");
  });

  it("the upload dialog names every accepted extension and offers them to the picker as .ext", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Upload document" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(new RegExp(UPLOAD_EXTENSION_ALLOWLIST.join(", "))),
    ).toBeTruthy();
    const accept = within(dialog).getByLabelText("File").getAttribute("accept")!.split(",");
    expect(accept).toEqual(
      expect.arrayContaining(UPLOAD_EXTENSION_ALLOWLIST.map((ext) => `.${ext}`)),
    );
    expect(accept).not.toContain("md");
  });

  it("says so when the server reports the feature off (404)", async () => {
    server.flagOn = false;
    mount();
    expect(await screen.findByText("Governing documents are not available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload document" })).toBeNull();
  });

  it("shows a load error that is not a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: false, error: { code: "INTERNAL", message: "Boom" } }),
            { status: 500 },
          ),
      ),
    );
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Boom (INTERNAL)");
  });

  it("shows the empty state, worded for the caller's role", async () => {
    mount();
    expect(
      await screen.findByText("Upload a policy or control framework to extract its rules."),
    ).toBeInTheDocument();
    auth.user = { id: "u-member", role: "viewer" };
    reload();
    expect(
      await screen.findByText(
        "A workspace admin uploads the policies and frameworks this workspace follows.",
      ),
    ).toBeInTheDocument();
  });
});
