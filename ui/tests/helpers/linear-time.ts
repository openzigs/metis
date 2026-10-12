/**
 * Assert that a call is LINEAR in its input, without betting on the clock.
 *
 * A timing test with an absolute bound near the figure an idle machine produces
 * fails on a busy one. `change-request.test.ts` held "200 KB of unclosed links"
 * to 100 ms; it takes about 30 ms on an idle laptop and took 148, 121 and 102 ms
 * on the three CI attempts of one run, where 1,455 test files share a runner
 * (PR #1090 review 3). The code was linear. The bound was the defect.
 *
 * What a test of this kind is for is the SHAPE: the patterns it guards against
 * are quadratic, so four times the input costs sixteen times as long, where a
 * linear one costs four. So:
 *
 *   1. a call that finishes inside {@link LINEAR_BOUND_MS} at full size passes.
 *      That is the bound `request-regex-fuzz.test.ts` uses, for the same reason:
 *      linear work on 200 KB is 0 to 30 ms, the quadratic patterns this guards
 *      against are 3,000 to 23,000;
 *   2. a call that does NOT is timed again at a quarter of the size, and passes
 *      when the ratio is under {@link MAX_LINEAR_RATIO}. A loaded machine slows
 *      both runs alike; a quadratic pattern does not get past 16.
 *
 * Nothing here is a wall-clock promise, and no test should add one.
 */
import { expect } from "vitest";

/** Shared with `request-regex-fuzz.test.ts`'s `BOUND_MS`. */
export const LINEAR_BOUND_MS = 250;
/** Time at N over time at N/4: 4 when linear, 16 when quadratic. */
export const MAX_LINEAR_RATIO = 8;

/**
 * Best of up to three runs. One run is enough when it is already inside the
 * bound, and a run four times over it is not load, so neither is repeated.
 */
export function bestMs(run: () => unknown, now: () => number = () => performance.now()): number {
  const once = () => {
    const start = now();
    run();
    return now() - start;
  };
  let best = once();
  for (let i = 0; i < 2 && best > LINEAR_BOUND_MS && best < LINEAR_BOUND_MS * 4; i++) {
    best = Math.min(best, once());
  }
  return best;
}

/**
 * `at(size)` builds the input for one size (not timed) and returns the call to
 * time. Passes when the call is fast at `fullSize`, or scales linearly from
 * `fullSize / 4`. `now` is the clock, replaceable so the helper can be tested.
 */
export function expectLinearTime(
  label: string,
  at: (size: number) => () => unknown,
  fullSize = 200_000,
  now: () => number = () => performance.now(),
): void {
  const large = bestMs(at(fullSize), now);
  if (large <= LINEAR_BOUND_MS) return;
  const small = bestMs(at(fullSize / 4), now);
  const ratio = large / Math.max(small, 1);
  expect(
    ratio,
    `${label}: ${Math.round(large)} ms at ${fullSize} characters, ${Math.round(small)} ms at ${fullSize / 4} — ` +
      `over ${LINEAR_BOUND_MS} ms and not linear (a ratio near 4 is linear, near 16 quadratic)`,
  ).toBeLessThan(MAX_LINEAR_RATIO);
}
