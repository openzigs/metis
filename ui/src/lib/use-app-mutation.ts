"use client";

/**
 * Shared mutation helper — Epic #238 (#241 standardized feedback + #242
 * consistent cache invalidation).
 *
 * Wraps TanStack Query's `useMutation` to give every high-traffic action a
 * single, consistent contract:
 *   - a pending flag the caller binds to `disabled` / spinner button state,
 *   - a success `sonner` toast (opt-out per call),
 *   - an error toast that surfaces the typed `ApiError` thrown by
 *     `api-client.ts` (its `.message` / `.code`) instead of failing silently —
 *     the core gap the epic targets (toasts in only 6 of 193 files), and
 *   - declarative cache invalidation (`invalidateKeys`) so screens reflect the
 *     mutation result without a manual refresh (#242).
 *
 * This is the single hook point #242 builds on: pass `invalidateKeys` and the
 * helper invalidates them on success. Optimistic updates can layer on via the
 * passthrough `onMutate` / `onSuccess` (both are still invoked).
 */
import { useMutation, useQueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "./api-client";

/** Resolve a human message from any thrown value, preferring the typed ApiError. */
export function resolveErrorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof ApiError) {
    // Surface the server-provided message; append the code when present for
    // support/debugging without dumping the whole envelope on the user.
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export interface AppMutationOptions<TData, TVariables> extends Omit<
  UseMutationOptions<TData, unknown, TVariables>,
  "mutationFn" | "onError" | "onSuccess"
> {
  mutationFn: (variables: TVariables) => Promise<TData>;
  /**
   * Success toast text. `false` disables the success toast. A function receives
   * the result + variables to build a contextual message.
   */
  successMessage?: string | false | ((data: TData, variables: TVariables) => string);
  /**
   * Error toast prefix/text. `false` disables the error toast (rare — only when
   * the caller renders its own inline error). A function may build the message.
   */
  errorMessage?: string | false | ((error: unknown, variables: TVariables) => string);
  /** Query keys to invalidate on success (#242). */
  invalidateKeys?: readonly (readonly unknown[])[];
  /** Still-invoked passthroughs so optimistic updates / extra side effects work. */
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: unknown, variables: TVariables) => void;
}

/**
 * `useMutation` wrapper that standardizes loading state, toasts, and cache
 * invalidation. Returns the standard mutation object; bind `.isPending` to the
 * triggering button's `disabled`/loading state.
 */
export function useAppMutation<TData = unknown, TVariables = void>(
  options: AppMutationOptions<TData, TVariables>,
) {
  const queryClient = useQueryClient();
  const { mutationFn, successMessage, errorMessage, invalidateKeys, onSuccess, onError, ...rest } =
    options;

  return useMutation<TData, unknown, TVariables>({
    ...rest,
    mutationFn,
    onSuccess: (data, variables) => {
      // #242 — invalidate declared caches so the UI converges immediately.
      if (invalidateKeys) {
        for (const key of invalidateKeys) {
          void queryClient.invalidateQueries({ queryKey: key as unknown[] });
        }
      }
      // #241 — success toast unless explicitly disabled.
      if (successMessage !== false) {
        const msg =
          typeof successMessage === "function"
            ? successMessage(data, variables)
            : (successMessage ?? "Done");
        toast.success(msg);
      }
      onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      // #241 — surface the typed ApiError instead of a silent failure.
      if (errorMessage !== false) {
        const msg =
          typeof errorMessage === "function"
            ? errorMessage(error, variables)
            : resolveErrorMessage(error, errorMessage || undefined);
        toast.error(msg);
      }
      onError?.(error, variables);
    },
  });
}
