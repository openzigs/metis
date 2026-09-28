/**
 * Issue #127 — Inference-profile picker card unit tests.
 *
 * Verifies load (populated + empty), save success with parsed Saved state,
 * client-side validation, and parsed error surfacing (no raw JSON blob).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api-client";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/inference-profile-api", () => ({
  inferenceProfileApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
}));

import { inferenceProfileApi } from "@/lib/inference-profile-api";
import { InferenceProfileCard } from "@/components/projects/inference-profile-card";

const get = inferenceProfileApi.get as unknown as ReturnType<typeof vi.fn>;
const update = inferenceProfileApi.update as unknown as ReturnType<typeof vi.fn>;

const VALID_ARN =
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6";

function renderCard() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <InferenceProfileCard projectId="p1" />
    </Wrapper>,
  );
}

beforeEach(() => {
  get.mockReset();
  update.mockReset();
});

describe("InferenceProfileCard", () => {
  it("loads and displays an existing profile", async () => {
    get.mockResolvedValue({
      profile: {
        id: "ip1",
        projectId: "p1",
        arn: VALID_ARN,
        modelId: "us.anthropic.claude-sonnet-4-6",
        costCenter: "eng",
        environment: "prod",
        tags: {},
        createdAt: "",
        updatedAt: "",
      },
    });
    renderCard();
    const arn = (await screen.findByTestId("inference-profile-arn")) as HTMLInputElement;
    expect(arn.value).toBe(VALID_ARN);
    expect((screen.getByTestId("inference-profile-model") as HTMLInputElement).value).toBe(
      "us.anthropic.claude-sonnet-4-6",
    );
  });

  it("shows an empty state when no profile is set", async () => {
    get.mockResolvedValue({ profile: null });
    renderCard();
    const arn = (await screen.findByTestId("inference-profile-arn")) as HTMLInputElement;
    expect(arn.value).toBe("");
  });

  it("validates that ARN and model id are required", async () => {
    get.mockResolvedValue({ profile: null });
    renderCard();
    await screen.findByTestId("inference-profile-arn");
    fireEvent.click(screen.getByTestId("inference-profile-save"));
    expect(await screen.findByTestId("inference-profile-form-error")).toHaveTextContent(
      /required/i,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("saves a new profile and shows the Saved toast", async () => {
    get.mockResolvedValue({ profile: null });
    update.mockResolvedValue({
      profile: {
        id: "ip1",
        projectId: "p1",
        arn: VALID_ARN,
        modelId: "us.anthropic.claude-sonnet-4-6",
        costCenter: null,
        environment: null,
        tags: {},
        createdAt: "",
        updatedAt: "",
      },
    });
    renderCard();
    await screen.findByTestId("inference-profile-arn");
    fireEvent.change(screen.getByTestId("inference-profile-arn"), {
      target: { value: VALID_ARN },
    });
    fireEvent.change(screen.getByTestId("inference-profile-model"), {
      target: { value: "us.anthropic.claude-sonnet-4-6" },
    });
    fireEvent.click(screen.getByTestId("inference-profile-save"));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith("p1", {
        arn: VALID_ARN,
        modelId: "us.anthropic.claude-sonnet-4-6",
        costCenter: undefined,
        environment: undefined,
      });
    });
    expect(await screen.findByTestId("inference-profile-saved-toast")).toBeInTheDocument();
  });

  it("surfaces a parsed error message on save failure", async () => {
    get.mockResolvedValue({ profile: null });
    update.mockRejectedValue(new ApiError(400, "Must be a valid Bedrock ARN", "VALIDATION_ERROR"));
    renderCard();
    await screen.findByTestId("inference-profile-arn");
    fireEvent.change(screen.getByTestId("inference-profile-arn"), {
      target: { value: VALID_ARN },
    });
    fireEvent.change(screen.getByTestId("inference-profile-model"), {
      target: { value: "m" },
    });
    fireEvent.click(screen.getByTestId("inference-profile-save"));
    expect(await screen.findByTestId("inference-profile-form-error")).toHaveTextContent(
      "Must be a valid Bedrock ARN",
    );
  });

  // #328 — the post-save refetch used to reset every field from the server
  // copy, wiping whatever the user had typed since. In CI the refetch landed
  // between the e2e's `fill("not-a-valid-arn")` and its Save click, so the
  // valid ARN was re-saved and the error never rendered.
  describe("post-save refetch vs unsaved edits (#328)", () => {
    const SAVED = {
      id: "ip1",
      projectId: "p1",
      arn: VALID_ARN,
      modelId: "us.anthropic.claude-sonnet-4-6",
      costCenter: null,
      environment: null,
      tags: {},
      createdAt: "",
      updatedAt: "",
    };

    function deferred<T>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    async function fillAndSave() {
      await screen.findByTestId("inference-profile-arn");
      fireEvent.change(screen.getByTestId("inference-profile-arn"), {
        target: { value: VALID_ARN },
      });
      fireEvent.change(screen.getByTestId("inference-profile-model"), {
        target: { value: SAVED.modelId },
      });
      fireEvent.click(screen.getByTestId("inference-profile-save"));
    }

    const arnValue = () => (screen.getByTestId("inference-profile-arn") as HTMLInputElement).value;

    it("keeps an edit typed after the save when the refetch lands later", async () => {
      const refetch = deferred<{ profile: typeof SAVED }>();
      get.mockResolvedValueOnce({ profile: null }).mockReturnValueOnce(refetch.promise);
      update.mockResolvedValue({ profile: SAVED });
      renderCard();
      await fillAndSave();
      await screen.findByTestId("inference-profile-saved-toast");
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

      fireEvent.change(screen.getByTestId("inference-profile-arn"), {
        target: { value: "not-a-valid-arn" },
      });
      refetch.resolve({ profile: SAVED });
      await refetch.promise;
      // Let react-query deliver the refetched data and effects run.
      await new Promise((r) => setTimeout(r, 0));
      await waitFor(() => expect(arnValue()).toBe("not-a-valid-arn"));
      await new Promise((r) => setTimeout(r, 20));
      expect(arnValue()).toBe("not-a-valid-arn");

      update.mockRejectedValueOnce(new ApiError(400, "Invalid inference profile ARN"));
      fireEvent.click(screen.getByTestId("inference-profile-save"));
      await waitFor(() =>
        expect(update).toHaveBeenLastCalledWith(
          "p1",
          expect.objectContaining({ arn: "not-a-valid-arn" }),
        ),
      );
      expect(await screen.findByTestId("inference-profile-form-error")).toHaveTextContent(
        "Invalid inference profile ARN",
      );
    });

    it("keeps an edit typed while the save is still in flight", async () => {
      const put = deferred<{ profile: typeof SAVED }>();
      get.mockResolvedValueOnce({ profile: null }).mockResolvedValue({ profile: SAVED });
      update.mockReturnValueOnce(put.promise);
      renderCard();
      await fillAndSave();
      fireEvent.change(screen.getByTestId("inference-profile-environment"), {
        target: { value: "staging" },
      });
      put.resolve({ profile: SAVED });
      await screen.findByTestId("inference-profile-saved-toast");
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      await new Promise((r) => setTimeout(r, 20));
      expect((screen.getByTestId("inference-profile-environment") as HTMLInputElement).value).toBe(
        "staging",
      );
    });

    it("still syncs a refetch into a form with no unsaved edits", async () => {
      get
        .mockResolvedValueOnce({ profile: null })
        .mockResolvedValue({ profile: { ...SAVED, costCenter: "set-by-server" } });
      update.mockResolvedValue({ profile: SAVED });
      renderCard();
      await fillAndSave();
      await screen.findByTestId("inference-profile-saved-toast");
      await waitFor(() =>
        expect(
          (screen.getByTestId("inference-profile-cost-center") as HTMLInputElement).value,
        ).toBe("set-by-server"),
      );
      expect(arnValue()).toBe(VALID_ARN);
    });
  });

  it("shows an error state when the profile fails to load", async () => {
    get.mockRejectedValue(new ApiError(500, "boom"));
    renderCard();
    expect(await screen.findByTestId("inference-profile-error")).toBeInTheDocument();
  });
});
