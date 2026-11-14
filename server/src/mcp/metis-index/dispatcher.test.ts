/**
 * #2331 — the dispatcher's own decisions, on a scripted caller and tool: the
 * order of the checks, what a failure says (never METIS's internals), the cap,
 * the redaction and the audit record. The real identity, ACL and tools are
 * driven end to end in `tests/mcp-metis-index-2331.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../middleware/error-handler.js";
import { UNRESTRICTED_CODE_ACCESS } from "../../lib/analysis/tools/code-access.js";

const m = vi.hoisted(() => ({
  resolveMcpCaller: vi.fn(),
  assertLiveProjectAccess: vi.fn(),
  loadCodeAccessFilter: vi.fn(),
  isServedProject: vi.fn(),
}));
vi.mock("./projects.js", () => ({ isServedProject: m.isServedProject }));
vi.mock("./identity.js", async (original) => ({
  ...(await original<typeof import("./identity.js")>()),
  resolveMcpCaller: m.resolveMcpCaller,
}));
vi.mock("../../lib/custom-agents/authz.js", () => ({
  assertLiveProjectAccess: m.assertLiveProjectAccess,
}));
vi.mock("../../lib/analysis/tools/code-access.js", async (original) => ({
  ...(await original<typeof import("../../lib/analysis/tools/code-access.js")>()),
  loadCodeAccessFilter: m.loadCodeAccessFilter,
}));

const { dispatchIndexTool, capResult, MAX_RESULT_CHARS, projectNotFoundMessage } =
  await import("./dispatcher.js");
const { McpAuthError, REFUSED_MESSAGE } = await import("./identity.js");
type Def = import("./tools.js").IndexToolDef;
type Shared = import("./tools.js").SharedResult;

/** Built, not written: a literal key-shaped string trips the repository's secret scanners. */
const AWS_KEY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");

const CALLER = { userId: "u1", tokenId: "t1", actor: { userId: "u1", role: "reader" } };

function def(
  result: Shared | (() => Promise<Shared>),
  projectScoped = true,
): Def & {
  run: ReturnType<typeof vi.fn>;
} {
  return {
    name: "metis_fake",
    description: "fake",
    inputSchema: {},
    projectScoped,
    run: vi.fn(typeof result === "function" ? result : async () => result),
    instructionsFor: (r: Shared) => (r.resultCount === 0 ? "EMPTY" : "SOURCE"),
  } as unknown as Def & { run: ReturnType<typeof vi.fn> };
}

const impls = { code: new Map(), listRequirements: {}, getRequirement: {} } as never;

describe("dispatchIndexTool", () => {
  const audit = vi.fn();
  const log = vi.fn();
  const env = { credential: "metis_x", impls, audit, log };

  beforeEach(() => {
    vi.clearAllMocks();
    m.resolveMcpCaller.mockResolvedValue(CALLER);
    m.assertLiveProjectAccess.mockResolvedValue(undefined);
    m.isServedProject.mockResolvedValue(true);
    m.loadCodeAccessFilter.mockResolvedValue(UNRESTRICTED_CODE_ACCESS);
  });

  it("checks identity, then project access, then loads the ACL filter, then runs", async () => {
    const order: string[] = [];
    m.resolveMcpCaller.mockImplementation(async () => (order.push("identity"), CALLER));
    m.assertLiveProjectAccess.mockImplementation(async () => void order.push("project"));
    m.loadCodeAccessFilter.mockImplementation(
      async () => (order.push("acl"), UNRESTRICTED_CODE_ACCESS),
    );
    const d = def(async () => (order.push("run"), { content: "hit", resultCount: 1 }));
    const out = await dispatchIndexTool(d, { projectId: "p1" }, env);
    expect(order).toEqual(["identity", "project", "acl", "run"]);
    expect(m.assertLiveProjectAccess).toHaveBeenCalledWith(CALLER.actor, "p1");
    expect(m.loadCodeAccessFilter).toHaveBeenCalledWith({ projectId: "p1", userId: "u1" });
    expect(d.run.mock.calls[0]![1]).toMatchObject({
      caller: CALLER,
      projectId: "p1",
      codeAccess: UNRESTRICTED_CODE_ACCESS,
    });
    expect(out).toEqual({
      isError: false,
      output: {
        tool: "metis_fake",
        projectId: "p1",
        result: "hit",
        resultCount: 1,
        truncated: false,
        citations: [],
        instructions: "SOURCE",
      },
    });
  });

  it("refuses a bad credential before anything is read, and audits the refusal", async () => {
    m.resolveMcpCaller.mockRejectedValue(new McpAuthError("invalid"));
    const d = def({ content: "x" });
    const out = await dispatchIndexTool(d, { projectId: "p1" }, env);
    expect(out).toEqual({ isError: true, message: REFUSED_MESSAGE });
    expect(m.assertLiveProjectAccess).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      actor: null,
      action: "mcp.index.denied",
      target: { type: "mcp_tool", id: "metis_fake" },
      metadata: { tool: "metis_fake", reason: "invalid" },
    });
  });

  it("says nothing of an internal error while checking the credential", async () => {
    m.resolveMcpCaller.mockRejectedValue(new Error("SQLITE_BUSY at /var/db/metis.db"));
    const out = await dispatchIndexTool(def({ content: "x" }), { projectId: "p1" }, env);
    expect(out.isError && out.message).toBe(
      "metis_fake failed: METIS could not check the credential.",
    );
    expect(JSON.stringify(out)).not.toContain("SQLITE");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("SQLITE_BUSY"));
  });

  it("answers a project the caller cannot read as not found, and does not run", async () => {
    m.assertLiveProjectAccess.mockRejectedValue(
      new AppError(404, "NOT_FOUND", "Project not found"),
    );
    const d = def({ content: "x" });
    const out = await dispatchIndexTool(d, { projectId: "p-secret" }, env);
    expect(out).toEqual({ isError: true, message: projectNotFoundMessage("metis_fake") });
    expect(d.run).not.toHaveBeenCalled();
    expect(m.loadCodeAccessFilter).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mcp.index.tool_call",
        target: { type: "project", id: "p-secret" },
        metadata: expect.objectContaining({ isError: true, resultCount: null }),
      }),
    );
  });

  it("answers a readable project metis_list_projects does not list (archived) as not found", async () => {
    m.isServedProject.mockResolvedValue(false);
    const d = def({ content: "x" });
    const out = await dispatchIndexTool(d, { projectId: "p-archived" }, env);
    expect(m.isServedProject).toHaveBeenCalledWith(CALLER.actor, "p-archived");
    expect(out).toEqual({ isError: true, message: projectNotFoundMessage("metis_fake") });
    expect(d.run).not.toHaveBeenCalled();
    expect(m.loadCodeAccessFilter).not.toHaveBeenCalled();
  });

  it("fails closed, with no detail, when the access check itself fails", async () => {
    m.assertLiveProjectAccess.mockRejectedValue(new Error("connection reset"));
    const d = def({ content: "x" });
    const out = await dispatchIndexTool(d, { projectId: "p1" }, env);
    expect(out).toEqual({
      isError: true,
      message: "metis_fake failed. Try again, or check metis_index_status.",
    });
    expect(d.run).not.toHaveBeenCalled();
  });

  it("fails closed when the caller's ACL filter cannot be loaded", async () => {
    m.loadCodeAccessFilter.mockRejectedValue(new Error("actor unresolved"));
    const d = def({ content: "x" });
    const out = await dispatchIndexTool(d, { projectId: "p1" }, env);
    expect(out.isError).toBe(true);
    expect(d.run).not.toHaveBeenCalled();
  });

  it("refuses a project-scoped call with no projectId", async () => {
    const d = def({ content: "x" });
    const out = await dispatchIndexTool(d, {}, env);
    expect(out).toEqual({ isError: true, message: "metis_fake: projectId is required." });
    expect(d.run).not.toHaveBeenCalled();
  });

  it("runs a tool that takes no project without a project check or ACL filter", async () => {
    const d = def({ content: "projects", resultCount: 2 }, false);
    const out = await dispatchIndexTool(d, { projectId: "ignored" }, env);
    expect(m.assertLiveProjectAccess).not.toHaveBeenCalled();
    expect(m.loadCodeAccessFilter).not.toHaveBeenCalled();
    expect(out.isError === false && out.output.projectId).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ target: { type: "user", id: "u1" } }),
    );
  });

  it("hides a tool's exception and logs it to stderr only", async () => {
    const d = def(async () => {
      throw new Error("ENOENT /srv/clones/rc1/.git");
    });
    const out = await dispatchIndexTool(d, { projectId: "p1" }, env);
    expect(out).toEqual({
      isError: true,
      message: "metis_fake failed. Try again, or check metis_index_status.",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
  });

  it("passes a tool's own error text on, redacted, with no instructions", async () => {
    const out = await dispatchIndexTool(
      def({ content: `Error: File not found: ${AWS_KEY}.ts`, isError: true }),
      { projectId: "p1" },
      env,
    );
    expect(out).toEqual({
      isError: true,
      message: "Error: File not found: [REDACTED:aws_key].ts",
    });
  });

  it("redacts secrets, reports the tool's truncation, and caps citations", async () => {
    const citations = Array.from({ length: 80 }, (_, i) => ({ path: `f${i}.ts` }));
    const out = await dispatchIndexTool(
      def({
        content: `key ${AWS_KEY} here`,
        resultCount: 80,
        truncated: true,
        citations: citations as never,
      }),
      { projectId: "p1" },
      env,
    );
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.output.result).toBe("key [REDACTED:aws_key] here");
    expect(out.output.truncated).toBe(true);
    expect(out.output.citations).toHaveLength(50);
  });

  it("caps a long result and reports it truncated", async () => {
    const out = await dispatchIndexTool(
      def({ content: "x".repeat(MAX_RESULT_CHARS + 10), resultCount: 1 }),
      { projectId: "p1" },
      env,
    );
    if (out.isError) throw new Error("unexpected error");
    expect(out.output.result.length).toBe(MAX_RESULT_CHARS);
    expect(out.output.truncated).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ truncated: true }) }),
    );
  });

  it("reports resultCount null when the tool does not count", async () => {
    const out = await dispatchIndexTool(def({ content: "status" }), { projectId: "p1" }, env);
    expect(out.isError === false && out.output.resultCount).toBeNull();
  });

  it("writes operator lines to stderr by default", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    m.resolveMcpCaller.mockRejectedValue(new McpAuthError("scope"));
    await dispatchIndexTool(def({ content: "x" }), {}, { credential: "c", impls, audit });
    expect(write).toHaveBeenCalledWith("metis-index-mcp: metis_fake refused (scope)\n");
    write.mockRestore();
  });
});

describe("capResult", () => {
  it("leaves a short result alone", () => {
    expect(capResult("abc")).toEqual({ text: "abc", capped: false });
  });

  it("cuts at the cap and says so", () => {
    const r = capResult("y".repeat(MAX_RESULT_CHARS + 1));
    expect(r.capped).toBe(true);
    expect(r.text.length).toBe(MAX_RESULT_CHARS);
    expect(r.text).toMatch(/truncated by METIS/);
  });
});
