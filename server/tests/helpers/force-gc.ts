/**
 * A forced, full garbage collection inside a test process, so that a heap
 * reading is what is RETAINED and not what happens to be uncollected.
 *
 * The suite does not run with `--expose-gc`; V8 lets the flag be set at run
 * time, and a fresh context then sees `gc`. Throws when that does not work, so
 * a test that depends on it fails loudly and never measures garbage instead.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

let collect: (() => void) | null = null;

export function forceGc(): void {
  if (!collect) {
    setFlagsFromString("--expose-gc");
    const gc: unknown = runInNewContext("gc");
    if (typeof gc !== "function") throw new Error("forceGc: V8 did not expose gc()");
    collect = gc as () => void;
  }
  // Twice: the first pass can leave what finalisers and weak references held.
  collect();
  collect();
}

/** The heap in use after a forced collection, in bytes. */
export function retainedHeap(): number {
  forceGc();
  return process.memoryUsage().heapUsed;
}

/**
 * The LEAST of three {@link retainedHeap} readings. One forced collection can
 * leave garbage that the next one frees (what a finaliser released, a parse
 * tree a weak reference still held), and a baseline read with that garbage in
 * it makes the growth measured after it too SMALL — which fails a test that
 * compares two growths, on code that did nothing wrong. Garbage only ever
 * adds to a reading, so the least of several is the closest to what is held;
 * a structure that is really retained is in all three.
 *
 * `readings` sets how many (two collections each). A BASELINE that another reading will
 * be subtracted from needs more than three (#1291): V8 releases some memory only once
 * enough full collections have passed, and when that happens inside the measured window
 * instead of before it, the growth reads too small — negative, once, in CI.
 */
export function settledHeap(readings = 3): number {
  let least = Number.POSITIVE_INFINITY;
  for (let i = 0; i < readings; i += 1) least = Math.min(least, retainedHeap());
  return least;
}
