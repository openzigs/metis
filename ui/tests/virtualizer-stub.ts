/**
 * #526 — `@tanstack/react-virtual` for jsdom. jsdom has no layout: every
 * element measures 0×0, so the real `useVirtualizer` mounts almost no rows.
 * This stand-in lays the rows out from `estimateSize` and returns those that
 * fall inside a viewport of `virtualWindow.height` pixels starting at
 * `virtualWindow.scrollTop` — `Infinity` (the default) returns every row.
 *
 * Use it with:
 *   vi.mock("@tanstack/react-virtual", async () => (await import("./virtualizer-stub")).module);
 */
export const virtualWindow = { scrollTop: 0, height: Infinity };

interface StubOptions {
  count: number;
  estimateSize: (index: number) => number;
  getItemKey?: (index: number) => string | number;
}

function useVirtualizer({ count, estimateSize, getItemKey }: StubOptions) {
  const items: { index: number; key: string | number; start: number; size: number; end: number }[] =
    [];
  let start = 0;
  for (let index = 0; index < count; index++) {
    const size = estimateSize(index);
    items.push({
      index,
      key: getItemKey ? getItemKey(index) : index,
      start,
      size,
      end: start + size,
    });
    start += size;
  }
  const { scrollTop, height } = virtualWindow;
  return {
    getTotalSize: () => start,
    getVirtualItems: () =>
      items.filter((item) => item.end > scrollTop && item.start < scrollTop + height),
    measureElement: () => {},
  };
}

export const module = { useVirtualizer };
