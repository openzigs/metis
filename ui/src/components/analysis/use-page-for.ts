"use client";

import { useState } from "react";

/**
 * #1137 — a page number that belongs to one list. When `key` changes (another
 * analysis, another base run), the page starts over at `first` instead of
 * carrying a page number that may not exist in the new list.
 */
export function usePageFor(key: string, first: number): [number, (page: number) => void] {
  const [state, setState] = useState({ key, page: first });
  const page = state.key === key ? state.page : first;
  return [page, (next: number) => setState({ key, page: next })];
}
