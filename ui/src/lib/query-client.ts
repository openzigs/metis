import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";

/**
 * Build a QueryClient with sensible UI defaults:
 * - 30s stale time so navigations re-show recent data without re-fetching
 * - 1 retry, but never on 4xx (those won't fix themselves)
 * - No refetch on window focus to avoid hammering the API in dev
 *
 * Mutations also retry once on transient 5xx but never on client errors.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status < 500) return false;
          return failureCount < 1;
        },
      },
      mutations: {
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status < 500) return false;
          return failureCount < 1;
        },
      },
    },
  });
}
