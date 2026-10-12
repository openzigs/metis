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
