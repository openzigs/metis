/**
 * v1.2.0 — smoke tests for the AiModelPicker component.
 *
 * Renders the picker, exercises the dirty-edit → save round-trip, the
 * empty-clears-override behaviour, and the inline error path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api-client";
import { AiModelPicker } from "@/components/projects/ai-model-picker";
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

function renderWithWrapper(node: React.ReactElement) {
  const Wrapper = makeWrapper({});
  return render(<Wrapper>{node}</Wrapper>);
}

describe("AiModelPicker", () => {
  it("renders the current model id and the hint", () => {
    renderWithWrapper(<AiModelPicker projectId="p1" current="anthropic.claude-3-5-sonnet" />);
    expect((screen.getByTestId("ai-model-input") as HTMLInputElement).value).toBe(
      "anthropic.claude-3-5-sonnet",
    );
    expect(screen.getByTestId("ai-model-picker")).toHaveTextContent(/global default/i);
  });

  it("PATCHes a trimmed model id on save", async () => {
    update.mockResolvedValue({
      id: "p1",
      aiModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    });
    renderWithWrapper(<AiModelPicker projectId="p1" current={null} />);
    const input = screen.getByTestId("ai-model-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "  us.anthropic.claude-sonnet-4-5-20250929-v1:0  " },
    });
    fireEvent.click(screen.getByTestId("ai-model-save"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith("p1", {
      aiModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    });
  });

  it("PATCHes null when the input is cleared", async () => {
    update.mockResolvedValue({ id: "p1", aiModel: null });
    renderWithWrapper(<AiModelPicker projectId="p1" current="anthropic.claude-3-5-sonnet" />);
    const input = screen.getByTestId("ai-model-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("ai-model-save"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith("p1", { aiModel: null });
  });

  it("surfaces server validation errors inline", async () => {
    update.mockRejectedValueOnce(
      new ApiError(400, "aiModel must be ≤ 200 characters", "INVALID_AI_MODEL"),
    );
    renderWithWrapper(<AiModelPicker projectId="p1" current={null} />);
    fireEvent.change(screen.getByTestId("ai-model-input"), {
      target: { value: "some-model-id" },
    });
    fireEvent.click(screen.getByTestId("ai-model-save"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/200 characters/i);
  });
});
