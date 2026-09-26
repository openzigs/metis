/**
 * Epic #108 (#114) — per-project AI provider picker exposes `local-gemma`.
 *
 * The picker renders `AI_PROVIDER_KEYS.map(...)` from `@metis/shared`, so once
 * `local-gemma` is added to that constant it must appear as a selectable
 * option and PATCH the project with the chosen provider on save.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AI_PROVIDER_KEYS } from "@metis/shared";
import { AiProviderPicker } from "@/components/projects/ai-provider-picker";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      update: vi.fn(),
    },
  };
});

import { projectsApi } from "@/lib/projects-api";

const update = projectsApi.update as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  update.mockReset();
});

function renderPicker(current: string | null = null) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <AiProviderPicker projectId="p1" current={current} />
    </Wrapper>,
  );
}

describe("AiProviderPicker — local-gemma (#114)", () => {
  it("includes local-gemma in the shared provider key constant", () => {
    expect(AI_PROVIDER_KEYS).toContain("local-gemma");
  });

  it("renders a local-gemma option in the select", () => {
    renderPicker();
    const select = screen.getByTestId("ai-provider-select") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("local-gemma");
  });

  it("saves the project with local-gemma as the provider", async () => {
    update.mockResolvedValue({ id: "p1", aiProviderId: "local-gemma" });
    renderPicker();
    fireEvent.change(screen.getByTestId("ai-provider-select"), {
      target: { value: "local-gemma" },
    });
    fireEvent.click(screen.getByTestId("ai-provider-save"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith("p1", { aiProviderId: "local-gemma" });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("reflects an existing local-gemma override as the current value", () => {
    renderPicker("local-gemma");
    expect((screen.getByTestId("ai-provider-select") as HTMLSelectElement).value).toBe(
      "local-gemma",
    );
  });
});

describe("AiProviderPicker — a removed provider (#149)", () => {
  it("no longer offers copilot-native", () => {
    expect(AI_PROVIDER_KEYS as readonly string[]).not.toContain("copilot-native");
    renderPicker();
    const select = screen.getByTestId("ai-provider-select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).not.toContain("copilot-native");
  });

  it("shows a stored copilot-native override as unsupported instead of as 'Global default'", () => {
    renderPicker("copilot-native");
    const select = screen.getByTestId("ai-provider-select") as HTMLSelectElement;
    expect(select.value).toBe("copilot-native");
    const stale = Array.from(select.options).find((o) => o.value === "copilot-native")!;
    expect(stale.disabled).toBe(true);
    expect(stale.textContent).toContain("no longer supported");
    expect(screen.getByTestId("ai-provider-unsupported").textContent).toContain("copilot-native");
  });

  it("a supported override shows no notice", () => {
    renderPicker("anthropic");
    expect(screen.queryByTestId("ai-provider-unsupported")).toBeNull();
  });
});
