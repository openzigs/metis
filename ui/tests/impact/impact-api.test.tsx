import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  streamFetch: vi.fn(),
}));

import { apiFetch, streamFetch } from "@/lib/api-client";
import { impactAnalysisApi } from "@/lib/impact-analysis-api";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("impactAnalysisApi", () => {
  it("POSTs the create payload", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "ia-1", status: "pending", projectIds: [] });
    await impactAnalysisApi.create({ text: "change", projectIds: ["project-001"] });
    expect(apiFetch).toHaveBeenCalledWith("/impact-analyses", {
      method: "POST",
      body: { text: "change", projectIds: ["project-001"] },
    });
  });

  it("GETs the list", async () => {
    vi.mocked(apiFetch).mockResolvedValue([]);
    await impactAnalysisApi.list();
    expect(apiFetch).toHaveBeenCalledWith("/impact-analyses");
  });

  it("#61 — narrows the list to one project", async () => {
    vi.mocked(apiFetch).mockResolvedValue([]);
    await impactAnalysisApi.list("p1");
    expect(apiFetch).toHaveBeenCalledWith("/impact-analyses", { params: { projectId: "p1" } });
  });

  it("GETs a single analysis by id", async () => {
    vi.mocked(apiFetch).mockResolvedValue({});
    await impactAnalysisApi.get("ia-0000000001");
    expect(apiFetch).toHaveBeenCalledWith("/impact-analyses/ia-0000000001");
  });

  it("#2280 — POSTs a re-run, with a body only when the document is to be read again", async () => {
    vi.mocked(apiFetch).mockResolvedValue({});
    await impactAnalysisApi.rerun("ia-1");
    expect(apiFetch).toHaveBeenLastCalledWith("/impact-analyses/ia-1/rerun", { method: "POST" });
    await impactAnalysisApi.rerun("ia-1", { rereadDocument: true });
    expect(apiFetch).toHaveBeenLastCalledWith("/impact-analyses/ia-1/rerun", {
      method: "POST",
      body: { rereadDocument: true },
    });
  });

  // #963 — markdown export.
  it("streams the markdown export and derives the filename", async () => {
    vi.mocked(streamFetch).mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["# Impact analysis"]),
      headers: new Headers({
        "content-disposition": 'attachment; filename="impact-analysis-ia-1.md"',
      }),
    } as unknown as Response);
    const { filename } = await impactAnalysisApi.exportReport("ia-1");
    expect(streamFetch).toHaveBeenCalledWith("/impact-analyses/ia-1/export.md", {
      method: "GET",
      headers: { Accept: "text/markdown" },
    });
    expect(filename).toBe("impact-analysis-ia-1.md");
  });

  it("throws with the parsed error when the export stream fails", async () => {
    vi.mocked(streamFetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "boom" } }),
      headers: new Headers(),
    } as unknown as Response);
    await expect(impactAnalysisApi.exportReport("ia-1")).rejects.toThrow(/boom/);
  });

  it("#2595 — downloads the hand-off in the format asked for", async () => {
    vi.mocked(streamFetch).mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["doc"]),
      headers: new Headers({
        "content-disposition": 'attachment; filename="Expiring keys - impact hand-off.pdf"',
      }),
    } as unknown as Response);
    const { filename } = await impactAnalysisApi.exportHandoff("ia/1", "pdf");
    expect(streamFetch).toHaveBeenCalledWith("/impact-analyses/ia%2F1/export?format=pdf", {
      method: "GET",
    });
    expect(filename).toBe("Expiring keys - impact hand-off.pdf");
  });

  it("#2595 — names the hand-off by its run when the server names none", async () => {
    vi.mocked(streamFetch).mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["doc"]),
      headers: new Headers(),
    } as unknown as Response);
    const { filename } = await impactAnalysisApi.exportHandoff("ia-1", "docx");
    expect(filename).toBe("impact-analysis-ia-1.docx");
  });

  it("#2595 — throws with the parsed error when the hand-off export fails", async () => {
    vi.mocked(streamFetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "format must be docx or pdf" } }),
      headers: new Headers(),
    } as unknown as Response);
    await expect(impactAnalysisApi.exportHandoff("ia-1", "docx")).rejects.toThrow(
      /format must be docx or pdf/,
    );
  });

  // #963 — Jira publish.
  it("POSTs the Jira publish request with an optional projectId", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ provider: "jira", issueKey: "IMP-1", url: "u" });
    await impactAnalysisApi.publishToJira("ia-1", { projectId: "project-002" });
    expect(apiFetch).toHaveBeenCalledWith("/impact-analyses/ia-1/publish/jira", {
      method: "POST",
      body: { projectId: "project-002" },
    });
  });

  it("defaults the Jira publish body to an empty object", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ provider: "jira", issueKey: "IMP-1", url: "u" });
    await impactAnalysisApi.publishToJira("ia-1");
    expect(apiFetch).toHaveBeenCalledWith("/impact-analyses/ia-1/publish/jira", {
      method: "POST",
      body: {},
    });
  });
});
