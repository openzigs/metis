/**
 * #2326 — `get_index_status`: the session project's index only, read-only,
 * and not counted as a project lookup by chat's grounding label.
 */
import { describe, expect, it, vi } from "vitest";

const status = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../ai/index-status.js", async (original) => ({
  ...(await original<typeof import("../../ai/index-status.js")>()),
  loadProjectIndexStatus: status.load,
}));

import { UNRESTRICTED_CODE_ACCESS } from "./code-access.js";
import { getChatCodeTools } from "./index.js";
import { CHAT_CODE_TOOL_NAMES } from "./chat-code-tool-names.js";
import { INDEX_STATUS_TOOL_NAME, indexStatusTool } from "./index-status.js";

const healthy = {
  projectId: "p1",
  projectName: "Acme",
  state: "healthy",
  documents: 3,
  repos: [],
  moreRepos: 0,
};

describe("get_index_status (#2326)", () => {
  it("reports the session's project, whatever project the model names", async () => {
    status.load.mockResolvedValue(healthy);
    const out = await indexStatusTool.execute(
      { projectId: "someone-elses-project" },
      { projectId: "p1", codeAccess: UNRESTRICTED_CODE_ACCESS },
    );
    expect(status.load).toHaveBeenCalledWith("p1", { access: UNRESTRICTED_CODE_ACCESS });
    expect(out.content).toContain('Project "Acme": index healthy; 3 knowledge document(s).');
    expect(out.isError).toBeUndefined();
    // A status report is not project content: no count, so no "project lookup".
    expect(out).not.toHaveProperty("resultCount");
  });

  it("says so when the project no longer exists", async () => {
    status.load.mockResolvedValue(null);
    await expect(indexStatusTool.execute({}, { projectId: "gone" })).resolves.toEqual({
      content: "Error: this chat's project no longer exists.",
      isError: true,
    });
    expect(status.load).toHaveBeenLastCalledWith("gone", {});
  });

  it("is a chat code tool an agent allowlist can name, offered unless turned off", () => {
    expect(CHAT_CODE_TOOL_NAMES).toContain(INDEX_STATUS_TOOL_NAME);
    expect(getChatCodeTools().map((t) => t.name)).toContain(INDEX_STATUS_TOOL_NAME);
    expect(getChatCodeTools(undefined, { indexStatus: false }).map((t) => t.name)).not.toContain(
      INDEX_STATUS_TOOL_NAME,
    );
    expect(indexStatusTool.parameters).toEqual({ type: "object", properties: {} });
  });
});
