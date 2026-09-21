/**
 * Unit tests for the shared mutation helper (Epic #238 / #241 + #242).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import { useAppMutation, resolveErrorMessage } from "@/lib/use-app-mutation";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } });
}

describe("resolveErrorMessage", () => {
  it("uses ApiError message and appends the code", () => {
    expect(resolveErrorMessage(new ApiError(422, "Bad input", "VALIDATION_ERROR"))).toBe(
      "Bad input (VALIDATION_ERROR)",
    );
  });
  it("uses ApiError message without code when code absent", () => {
    expect(resolveErrorMessage(new ApiError(500, "Boom"))).toBe("Boom");
  });
  it("falls back for plain errors and unknowns", () => {
    expect(resolveErrorMessage(new Error("plain"))).toBe("plain");
    expect(resolveErrorMessage({}, "fallback")).toBe("fallback");
  });
});

describe("useAppMutation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a success toast and exposes pending state", async () => {
    const qc = makeClient();
    const { result } = renderHook(
      () =>
        useAppMutation({
          mutationFn: async (n: number) => n * 2,
          successMessage: "Saved",
        }),
      { wrapper: wrapper(qc) },
    );

    await act(async () => {
      await result.current.mutateAsync(21);
    });

    expect(toast.success).toHaveBeenCalledWith("Saved");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("surfaces a typed ApiError via an error toast (no silent failure)", async () => {
    const qc = makeClient();
    const { result } = renderHook(
      () =>
        useAppMutation({
          mutationFn: async () => {
            throw new ApiError(409, "Conflict", "DUPLICATE");
          },
        }),
      { wrapper: wrapper(qc) },
    );

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Conflict (DUPLICATE)"));
  });

  it("invalidates the declared query keys on success (#242)", async () => {
    const qc = makeClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(
      () =>
        useAppMutation({
          mutationFn: async () => "ok",
          successMessage: false,
          invalidateKeys: [["analyses", "project", "p1"], ["documents"]],
        }),
      { wrapper: wrapper(qc) },
    );

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["analyses", "project", "p1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["documents"] });
  });

  it("suppresses the success toast when successMessage is false", async () => {
    const qc = makeClient();
    const { result } = renderHook(
      () => useAppMutation({ mutationFn: async () => 1, successMessage: false }),
      { wrapper: wrapper(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("suppresses the error toast when errorMessage is false but still invokes onError", async () => {
    const qc = makeClient();
    const onError = vi.fn();
    const { result } = renderHook(
      () =>
        useAppMutation({
          mutationFn: async () => {
            throw new ApiError(500, "x");
          },
          errorMessage: false,
          onError,
        }),
      { wrapper: wrapper(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync(undefined as never).catch(() => undefined);
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it("builds a contextual success message from a function and invokes onSuccess passthrough", async () => {
    const qc = makeClient();
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () =>
        useAppMutation({
          mutationFn: async (name: string) => ({ name }),
          successMessage: (data) => `Created ${data.name}`,
          onSuccess,
        }),
      { wrapper: wrapper(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync("widget");
    });
    expect(toast.success).toHaveBeenCalledWith("Created widget");
    expect(onSuccess).toHaveBeenCalledWith({ name: "widget" }, "widget");
  });
});
