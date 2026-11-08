/**
 * #1871 — the workspace governing documents page.
 *
 * `fetch` is replaced by an in-memory fake of the #1869/#1870 routes, with the
 * server's own envelopes, status codes and role rule (a member gets 403 on a
 * write). A "reload" unmounts the panel and mounts it again over a fresh
 * QueryClient, so what it then shows came from the fake server's store, never
 * from the first mount's cache or an optimistic update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MAX_DOCUMENT_BYTES } from "@metis/shared";

const auth: { user: { id: string; role: string } | null } = {
  user: { id: "u-admin", role: "viewer" },
};
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }));

import {
  GoverningDocumentsPanel,
  formatEffectiveDate,
  isExtractionUnsettled,
} from "./governing-documents-panel";
import {
  canManageGoverning,
  isGoverningUnavailable,
  useGoverningTabVisible,
} from "@/lib/governing-api";
import { ApiError } from "@/lib/api-client";

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
    });
    for (const r of opts.rules ?? []) {
      this.rules.push({
        ...r,
        id: this.nextId("rule"),
        revisionId: revision.id,
        editedAt: null,
        deletedAt: null,
      });
    }
    return { doc, revision };
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
    >,
  ): FakeRevision {
    const revision: FakeRevision = {
      id: this.nextId("rev"),
      documentId: doc.id,
      mimeType: "text/markdown",
      sizeBytes: 10,
      indexState: "indexed",
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
      rev.extractionState = "pending";
      rev.extractionError = null;
      return json(202, { documentId: doc.id, revisionId: rev.id, scheduled: true });
    }
    return err(404, "NOT_FOUND", "Not found");
  };
}

let server: FakeServer;

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GoverningDocumentsPanel workspaceId={WS} />
    </QueryClientProvider>,
  );
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
  vi.unstubAllGlobals();
});

describe("pure helpers", () => {
  it("isExtractionUnsettled is true only for pending and running", () => {
    expect(isExtractionUnsettled("pending")).toBe(true);
    expect(isExtractionUnsettled("running")).toBe(true);
    expect(isExtractionUnsettled("done")).toBe(false);
    expect(isExtractionUnsettled("failed")).toBe(false);
    expect(isExtractionUnsettled(undefined)).toBe(false);
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
    mount();
    const table = await screen.findByRole("table", { name: "Governing documents" });
    // The workspace's members have loaded (the role decision is made on them).
    await waitFor(() =>
      expect(server.requests.some((r) => r.path === `/api/workspaces/${WS}`)).toBe(true),
    );
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
    // The list re-reads the server, which now reports the revision pending.
    await waitFor(() => expect(screen.queryByText("Provider timed out")).toBeNull());
    expect(screen.getByText("pending")).toBeInTheDocument();
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
