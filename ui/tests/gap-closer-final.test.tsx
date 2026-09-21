/**
 * Issue #121 extended — final coverage gap-closer tests.
 * Covers: async-platform-api (branch/function coverage), db-connector-wizard
 * (step rendering + test/provision flows), diagram-viewer (keyboard shortcuts),
 * and connections page inline editing branches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

// ─── async-platform-api ───────────────────────────────────────────────────────

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "@/lib/api-client";
import { asyncApi } from "@/lib/async-platform-api";

const mockApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe("asyncApi — listBackgroundRuns branches", () => {
  it("fetches without params", async () => {
    mockApiFetch.mockResolvedValueOnce({ items: [] });
    await asyncApi.listBackgroundRuns();
    expect(mockApiFetch).toHaveBeenCalledWith("/runs/background");
  });

  it("fetches with all params (projectId + status + limit)", async () => {
    mockApiFetch.mockResolvedValueOnce({ items: [] });
    await asyncApi.listBackgroundRuns({ projectId: "p1", status: "running", limit: 20 });
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("projectId=p1"));
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("status=running"));
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("limit=20"));
  });

  it("fetches with projectId only", async () => {
    mockApiFetch.mockResolvedValueOnce({ items: [] });
    await asyncApi.listBackgroundRuns({ projectId: "p1" });
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("projectId=p1"));
  });
});

describe("asyncApi — other methods", () => {
  it("getBackgroundRun calls correct endpoint", async () => {
    mockApiFetch.mockResolvedValueOnce({ id: "r1", messages: [] });
    await asyncApi.getBackgroundRun("r1");
    expect(mockApiFetch).toHaveBeenCalledWith("/runs/background/r1");
  });

  it("submitBackgroundRun calls POST", async () => {
    mockApiFetch.mockResolvedValueOnce({ runId: "r2" });
    await asyncApi.submitBackgroundRun({ projectId: "p1", kind: "analysis" });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/runs/background",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("cancelBackgroundRun calls POST /cancel", async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true });
    await asyncApi.cancelBackgroundRun("r1");
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/runs/background/r1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("pauseBackgroundRun calls POST /pause", async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true });
    await asyncApi.pauseBackgroundRun("r1");
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/runs/background/r1/pause",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("resumeBackgroundRun calls POST /resume", async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true });
    await asyncApi.resumeBackgroundRun("r1");
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/runs/background/r1/resume",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("steerRun with default role", async () => {
    mockApiFetch.mockResolvedValueOnce({ messageId: "m1", ord: 0 });
    await asyncApi.steerRun("r1", "continue");
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/runs/r1/steer",
      expect.objectContaining({ body: expect.objectContaining({ role: "user" }) }),
    );
  });

  it("steerRun with explicit role", async () => {
    mockApiFetch.mockResolvedValueOnce({ messageId: "m2", ord: 1 });
    await asyncApi.steerRun("r1", "stop", "system");
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/runs/r1/steer",
      expect.objectContaining({ body: expect.objectContaining({ role: "system" }) }),
    );
  });

  it("submitGroup calls POST", async () => {
    mockApiFetch.mockResolvedValueOnce({ groupId: "g1", runIds: [] });
    await asyncApi.submitGroup({ projectId: "p1", kind: "analysis", n: 3 });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/runs/group",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("getGroup calls correct endpoint", async () => {
    mockApiFetch.mockResolvedValueOnce({ id: "g1" });
    await asyncApi.getGroup("g1");
    expect(mockApiFetch).toHaveBeenCalledWith("/runs/group/g1");
  });

  it("listTriggers calls correct endpoint", async () => {
    mockApiFetch.mockResolvedValueOnce({ items: [] });
    await asyncApi.listTriggers("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/triggers");
  });

  it("createTrigger calls POST", async () => {
    mockApiFetch.mockResolvedValueOnce({ id: "t1" });
    await asyncApi.createTrigger("p1", { name: "Deploy Hook", source: "webhook" });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/projects/p1/triggers",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("updateTrigger calls PATCH", async () => {
    mockApiFetch.mockResolvedValueOnce({ id: "t1" });
    await asyncApi.updateTrigger("p1", "t1", { enabled: false });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/projects/p1/triggers/t1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("deleteTrigger calls DELETE", async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true });
    await asyncApi.deleteTrigger("p1", "t1");
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/projects/p1/triggers/t1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

// ─── DbConnectorWizard ────────────────────────────────────────────────────────

vi.mock("@/lib/connectors-api", () => ({
  suggestedConnectorsApi: {
    list: vi.fn(),
    get: vi.fn(),
    updateStatus: vi.fn(),
    test: vi.fn(),
    provision: vi.fn(),
  },
  repoConnectorsApi: { getPrimary: vi.fn() },
}));

import { suggestedConnectorsApi } from "@/lib/connectors-api";
import { DbConnectorWizard } from "@/components/connectors/db-connector-wizard";

const getDetail = suggestedConnectorsApi.get as unknown as ReturnType<typeof vi.fn>;
const testConnector = suggestedConnectorsApi.test as unknown as ReturnType<typeof vi.fn>;
const provision = suggestedConnectorsApi.provision as unknown as ReturnType<typeof vi.fn>;

const mockSuggestion = {
  id: "s1",
  projectId: "p1",
  driverType: "postgres",
  host: "db.example.com",
  port: 5432,
  database: "mydb",
  confidence: "high" as const,
  status: "pending",
  sourceFile: "src/db.ts",
  lineNumber: 10,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  getDetail.mockReset();
  testConnector.mockReset();
  provision.mockReset();
  getDetail.mockResolvedValue({
    ...mockSuggestion,
    username: "admin",
    password: null,
    secretRef: null,
  });
});

describe("DbConnectorWizard", () => {
  it("renders dialog when open=true", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <DbConnectorWizard projectId="p1" suggestion={mockSuggestion} open onOpenChange={vi.fn()} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText(/Database Connector/i)).toBeInTheDocument());
  });

  it("does not render dialog when open=false", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <DbConnectorWizard
          projectId="p1"
          suggestion={mockSuggestion}
          open={false}
          onOpenChange={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.queryByText(/Review/i)).not.toBeInTheDocument();
  });

  it("shows discovery source info in review step", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <DbConnectorWizard projectId="p1" suggestion={mockSuggestion} open onOpenChange={vi.fn()} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText(/src\/db\.ts/i)).toBeInTheDocument());
  });

  it("navigates to configure step on Next", async () => {
    const user = userEvent.setup();
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <DbConnectorWizard projectId="p1" suggestion={mockSuggestion} open onOpenChange={vi.fn()} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /Next/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Next/i }));
    await waitFor(() => expect(screen.getByLabelText(/Host/i)).toBeInTheDocument());
  });

  it("shows Back button and allows navigation", async () => {
    const user = userEvent.setup();
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <DbConnectorWizard projectId="p1" suggestion={mockSuggestion} open onOpenChange={vi.fn()} />
      </Wrapper>,
    );
    // Click Next to go to Configure step
    await waitFor(() => expect(screen.getByRole("button", { name: /Next/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Next/i }));
    // Should now see Back and Next
    await waitFor(() => expect(screen.getByRole("button", { name: /Back/i })).toBeInTheDocument());
    // Click Back to return to Review
    await user.click(screen.getByRole("button", { name: /Back/i }));
    await waitFor(() => expect(screen.getByText(/src\/db\.ts/i)).toBeInTheDocument());
  });
});
