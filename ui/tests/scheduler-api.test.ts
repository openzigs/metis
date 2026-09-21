/**
 * Coverage for the Phase 11 scheduler / tasks API wrappers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schedulerApi, tasksApi } from "@/lib/scheduler-api";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({} as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("schedulerApi", () => {
  it("list / get / create / update / remove / runNow / pause / resume / history / handlers", async () => {
    await schedulerApi.list();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler", { params: undefined });
    await schedulerApi.list({ projectId: "p1" });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler", { params: { projectId: "p1" } });
    await schedulerApi.get("j1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler/j1");
    await schedulerApi.create({
      key: "k",
      name: "n",
      cron: "* * * * *",
      taskType: "rerun-analysis",
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler", {
      method: "POST",
      body: { key: "k", name: "n", cron: "* * * * *", taskType: "rerun-analysis" },
    });
    await schedulerApi.update("j1", { enabled: false });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler/j1", {
      method: "PATCH",
      body: { enabled: false },
    });
    await schedulerApi.remove("j1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler/j1", { method: "DELETE" });
    await schedulerApi.runNow("j1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler/j1/run", { method: "POST" });
    await schedulerApi.pause("j1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler/j1/pause", { method: "POST" });
    await schedulerApi.resume("j1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler/j1/resume", { method: "POST" });
    await schedulerApi.history("j1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler/j1/history");
    await schedulerApi.handlers();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/scheduler/handlers");
  });
});

describe("tasksApi", () => {
  it("list / get / cancel / retry", async () => {
    await tasksApi.list();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/tasks", { params: undefined });
    await tasksApi.list({ status: "pending", take: 50 });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/tasks", {
      params: { status: "pending", take: 50 },
    });
    await tasksApi.get("t1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/tasks/t1");
    await tasksApi.cancel("t1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/tasks/t1/cancel", { method: "POST" });
    await tasksApi.retry("t1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/tasks/t1/retry", { method: "POST" });
  });
});
