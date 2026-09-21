/**
 * Settings → Triggers page (#147) — usability quick win.
 *
 * Covers the new searchable project picker (replacing the raw Project ID
 * text input) and the list-query error branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

vi.mock("@/lib/async-platform-api", () => ({
  asyncApi: {
    listTriggers: vi.fn(),
    createTrigger: vi.fn(),
    updateTrigger: vi.fn(),
    deleteTrigger: vi.fn(),
  },
}));

import { apiFetch } from "@/lib/api-client";
import { asyncApi } from "@/lib/async-platform-api";
import TriggersSettingsPage from "@/app/(authed)/settings/triggers/page";

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const listTriggersMock = asyncApi.listTriggers as unknown as ReturnType<typeof vi.fn>;
const createTriggerMock = asyncApi.createTrigger as unknown as ReturnType<typeof vi.fn>;
const updateTriggerMock = asyncApi.updateTrigger as unknown as ReturnType<typeof vi.fn>;
const deleteTriggerMock = asyncApi.deleteTrigger as unknown as ReturnType<typeof vi.fn>;

async function pickProject(id: string) {
  const trigger = await screen.findByTestId("tg-project-id");
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByTestId(`tg-project-option-${id}`));
}

function makeTriggerRow(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    projectId: "proj_alpha",
    name: "GH Issues",
    source: "github",
    config: { repo: "acme/app" },
    enabled: true,
    lastFiredAt: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const PROJECTS = [
  { id: "proj_alpha", name: "Alpha Project" },
  { id: "proj_beta", name: "Beta Project" },
];

beforeEach(() => {
  apiFetchMock.mockReset();
  listTriggersMock.mockReset();
  // `/search/projects` for the picker.
  apiFetchMock.mockResolvedValue(PROJECTS);
  listTriggersMock.mockResolvedValue({ items: [] });
});

describe("TriggersSettingsPage — project picker", () => {
  it("lists accessible projects in the picker and selecting one drives the trigger list", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <TriggersSettingsPage />
      </Wrapper>,
    );

    // Picker trigger retains the legacy data-testid.
    const trigger = await screen.findByTestId("tg-project-id");
    expect(trigger).toHaveTextContent("Select a project");
    // Picker is disabled until the project list resolves.
    await waitFor(() => expect(trigger).not.toBeDisabled());

    fireEvent.click(trigger);
    // Project options appear.
    expect(await screen.findByText("Alpha Project")).toBeInTheDocument();
    expect(screen.getByText("Beta Project")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tg-project-option-proj_beta"));

    // Selecting a project enables the trigger list query for that project id.
    await waitFor(() => expect(listTriggersMock).toHaveBeenCalledWith("proj_beta"));
    expect(screen.getByTestId("tg-project-id")).toHaveTextContent("Beta Project");
  });

  it("filters projects by the search box", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <TriggersSettingsPage />
      </Wrapper>,
    );
    const trigger = await screen.findByTestId("tg-project-id");
    await waitFor(() => expect(trigger).not.toBeDisabled());
    fireEvent.click(trigger);
    fireEvent.change(screen.getByTestId("tg-project-search"), { target: { value: "beta" } });

    expect(screen.queryByText("Alpha Project")).not.toBeInTheDocument();
    expect(screen.getByText("Beta Project")).toBeInTheDocument();
  });

  it("renders an error state with retry when the triggers list fails", async () => {
    listTriggersMock.mockRejectedValue(new Error("boom"));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <TriggersSettingsPage />
      </Wrapper>,
    );
    const trigger = await screen.findByTestId("tg-project-id");
    await waitFor(() => expect(trigger).not.toBeDisabled());
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("tg-project-option-proj_alpha"));

    await waitFor(() =>
      expect(screen.getByTestId("tg-error")).toHaveTextContent("Failed to load triggers"),
    );

    // Retry re-runs the query.
    listTriggersMock.mockResolvedValueOnce({ items: [] });
    fireEvent.click(screen.getByTestId("tg-retry"));
    await waitFor(() => expect(listTriggersMock.mock.calls.length).toBeGreaterThan(1));
  });

  it("shows 'No projects found' when the search matches nothing", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <TriggersSettingsPage />
      </Wrapper>,
    );
    const trigger = await screen.findByTestId("tg-project-id");
    await waitFor(() => expect(trigger).not.toBeDisabled());
    fireEvent.click(trigger);
    fireEvent.change(screen.getByTestId("tg-project-search"), { target: { value: "zzz" } });
    expect(screen.getByText("No projects found")).toBeInTheDocument();
  });
});

describe("TriggersSettingsPage — trigger CRUD", () => {
  it("creates a trigger with parsed extra-config JSON and a secret", async () => {
    listTriggersMock.mockResolvedValue({ items: [] });
    createTriggerMock.mockResolvedValue(makeTriggerRow({ id: "t2", name: "Hook" }));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <TriggersSettingsPage />
      </Wrapper>,
    );
    await pickProject("proj_alpha");
    fireEvent.change(await screen.findByTestId("tg-name"), { target: { value: "Hook" } });
    fireEvent.change(screen.getByTestId("tg-source"), { target: { value: "github" } });
    fireEvent.change(screen.getByTestId("tg-secret"), { target: { value: "shh" } });
    fireEvent.change(screen.getByTestId("tg-config"), {
      target: { value: '{"repo":"acme/app"}' },
    });
    fireEvent.click(screen.getByTestId("tg-save"));
    await waitFor(() =>
      expect(createTriggerMock).toHaveBeenCalledWith("proj_alpha", {
        name: "Hook",
        source: "github",
        config: { secret: "shh", repo: "acme/app" },
      }),
    );
  });

  it("toggles and deletes an existing trigger", async () => {
    listTriggersMock.mockResolvedValue({ items: [makeTriggerRow({ enabled: false })] });
    updateTriggerMock.mockResolvedValue(makeTriggerRow());
    deleteTriggerMock.mockResolvedValue(undefined);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <TriggersSettingsPage />
      </Wrapper>,
    );
    await pickProject("proj_alpha");
    await waitFor(() => expect(screen.getByTestId("tg-row-t1")).toBeInTheDocument());
    // Disabled badge + repo config rendered.
    expect(screen.getByText("disabled")).toBeInTheDocument();
    expect(screen.getByText(/repo=acme\/app/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tg-toggle-t1"));
    await waitFor(() =>
      expect(updateTriggerMock).toHaveBeenCalledWith("proj_alpha", "t1", { enabled: true }),
    );

    fireEvent.click(screen.getByTestId("tg-delete-t1"));
    await waitFor(() => expect(deleteTriggerMock).toHaveBeenCalledWith("proj_alpha", "t1"));
  });

  it("renders the empty-state when a project has no triggers", async () => {
    listTriggersMock.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <TriggersSettingsPage />
      </Wrapper>,
    );
    await pickProject("proj_alpha");
    await waitFor(() => expect(screen.getByText("No triggers.")).toBeInTheDocument());
  });
});
