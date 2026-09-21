/**
 * Issue #123 — Plugins import/export manager unit tests.
 *
 * Covers select→export (download), name validation, upload→import success
 * summary, malformed-JSON rejection, and parsed server-error surfacing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api-client";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/library-api", () => ({
  skillsApi: { list: vi.fn() },
}));
vi.mock("@/lib/sdk-alignment-api", () => ({
  sdkApi: { listAgents: vi.fn(), listHooks: vi.fn() },
}));
vi.mock("@/lib/plugins-api", () => ({
  pluginsApi: { exportPlugin: vi.fn(), importPlugin: vi.fn() },
  triggerDownload: vi.fn(),
}));

import { skillsApi } from "@/lib/library-api";
import { sdkApi } from "@/lib/sdk-alignment-api";
import { pluginsApi, triggerDownload } from "@/lib/plugins-api";
import { PluginsManager } from "@/components/projects/plugins-manager";

const listSkills = skillsApi.list as unknown as ReturnType<typeof vi.fn>;
const listAgents = sdkApi.listAgents as unknown as ReturnType<typeof vi.fn>;
const listHooks = sdkApi.listHooks as unknown as ReturnType<typeof vi.fn>;
const exportPlugin = pluginsApi.exportPlugin as unknown as ReturnType<typeof vi.fn>;
const importPlugin = pluginsApi.importPlugin as unknown as ReturnType<typeof vi.fn>;
const download = triggerDownload as unknown as ReturnType<typeof vi.fn>;

function renderManager() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <PluginsManager projectId="proj1" />
    </Wrapper>,
  );
}

beforeEach(() => {
  listSkills.mockReset().mockResolvedValue({
    items: [
      { id: "s1", name: "Doc Skill" },
      { id: "s2", name: "Code Skill" },
    ],
  });
  listAgents.mockReset().mockResolvedValue([{ id: "a1", name: "Reviewer" }]);
  listHooks.mockReset().mockResolvedValue([{ id: "h1", event: "pre-run", handlerKind: "builtin" }]);
  exportPlugin.mockReset();
  importPlugin.mockReset();
  download.mockReset();
});

describe("PluginsManager — export", () => {
  it("renders selectable skills, agents, and hooks", async () => {
    renderManager();
    expect(await screen.findByLabelText("Skill Doc Skill")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent Reviewer")).toBeInTheDocument();
    expect(screen.getByLabelText("Hook pre-run")).toBeInTheDocument();
  });

  it("blocks export when the plugin name is invalid", async () => {
    renderManager();
    await screen.findByLabelText("Skill Doc Skill");
    fireEvent.change(screen.getByTestId("plugin-name"), { target: { value: "Bad Name!" } });
    fireEvent.click(screen.getByTestId("plugin-export-button"));
    expect(await screen.findByTestId("plugin-export-error")).toHaveTextContent(/lowercase/i);
    expect(exportPlugin).not.toHaveBeenCalled();
  });

  it("exports the selected items and triggers a download", async () => {
    exportPlugin.mockResolvedValue({ blob: new Blob(["{}"]), filename: "metis-plugin-demo.json" });
    renderManager();
    await screen.findByLabelText("Skill Doc Skill");
    fireEvent.change(screen.getByTestId("plugin-name"), { target: { value: "demo" } });
    fireEvent.click(screen.getByLabelText("Skill Doc Skill"));
    fireEvent.click(screen.getByLabelText("Agent Reviewer"));
    fireEvent.click(screen.getByTestId("plugin-export-button"));
    await waitFor(() => {
      expect(exportPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "demo",
          skillIds: ["s1"],
          customAgentIds: ["a1"],
          hookIds: [],
        }),
      );
    });
    expect(download).toHaveBeenCalledWith(expect.any(Blob), "metis-plugin-demo.json");
  });

  it("surfaces a parsed export error", async () => {
    exportPlugin.mockRejectedValue(new Error("server says no"));
    renderManager();
    await screen.findByLabelText("Skill Doc Skill");
    fireEvent.change(screen.getByTestId("plugin-name"), { target: { value: "demo" } });
    fireEvent.click(screen.getByTestId("plugin-export-button"));
    expect(await screen.findByTestId("plugin-export-error")).toHaveTextContent("server says no");
  });
});

describe("PluginsManager — import", () => {
  function uploadFile(contents: string, name = "plugin.json") {
    const file = new File([contents], name, { type: "application/json" });
    fireEvent.change(screen.getByTestId("plugin-import-file"), { target: { files: [file] } });
  }

  it("imports a valid envelope and shows a summary", async () => {
    importPlugin.mockResolvedValue({
      manifest: { name: "demo", version: "1.0.0", description: "" },
      installed: { skills: 2, agents: 1, hooks: 0 },
    });
    renderManager();
    await screen.findByLabelText("Skill Doc Skill");
    uploadFile(JSON.stringify({ manifest: { name: "demo" } }));
    const success = await screen.findByTestId("plugin-import-success");
    expect(success).toHaveTextContent("2 skill(s)");
    expect(importPlugin).toHaveBeenCalledWith("proj1", { manifest: { name: "demo" } });
  });

  it("rejects malformed JSON before calling the server", async () => {
    renderManager();
    await screen.findByLabelText("Skill Doc Skill");
    uploadFile("{ not json");
    expect(await screen.findByTestId("plugin-import-error")).toHaveTextContent(/not valid JSON/i);
    expect(importPlugin).not.toHaveBeenCalled();
  });

  it("surfaces a parsed server validation error", async () => {
    importPlugin.mockRejectedValue(new ApiError(400, "Invalid plugin envelope", "PLUGIN_FORMAT"));
    renderManager();
    await screen.findByLabelText("Skill Doc Skill");
    uploadFile(JSON.stringify({ manifest: {} }));
    expect(await screen.findByTestId("plugin-import-error")).toHaveTextContent(
      "Invalid plugin envelope",
    );
  });
});
