/**
 * Epic #1316 / issue #1321 — online-eval token budget.
 *
 * A per-calendar-month token allowance for judge calls made against sampled
 * live traffic. It is deliberately SEPARATE from `ANALYSIS_MONTHLY_TOKEN_CAP`
 * (`server/src/lib/analysis/cost-cap.ts`): observing quality must never eat the
 * allowance a user's analysis run needs.
 *
 * Enforcement is a *reservation* taken BEFORE the judge is called, not an
 * after-the-fact report. `reserve()` debits the estimate up front and returns
 * `allowed: false` once the month's ledger is spent; `settle()` reconciles the
 * estimate against the actual usage afterwards. A judge call that is never
 * reserved never happens.
 *
 * Fail-closed: a cap of 0 denies every reservation. The kill switch for the
 * feature is `ONLINE_EVAL_ENABLED`, so "no budget" unambiguously means "spend
 * nothing" rather than "spend without limit".
 *
 * The ledger is file-backed (`<resultsDir>/budget.json`) and holds counters
 * only — no user content, no project ids.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { onlineEvalBudgetStateSchema, type OnlineEvalBudgetState } from "@metis/shared";

export type BudgetDenyReason = "NO_BUDGET_CONFIGURED" | "MONTHLY_BUDGET_EXCEEDED";

export interface BudgetDecision {
  allowed: boolean;
  reason: "OK" | BudgetDenyReason;
  /** Tokens actually debited by this reservation (0 when denied). */
  reserved: number;
  state: OnlineEvalBudgetState;
}

export interface OnlineEvalBudgetOptions {
  /**
   * Directory holding `budget.json`. Accepts a thunk so the ledger follows a
   * runtime `ONLINE_EVAL_RESULTS_DIR` change instead of pinning the value
   * captured at construction (the windows are re-resolved per call).
   */
  dir: string | (() => string);
  /** Monthly cap, re-read on every reservation so an admin change takes effect. */
  cap: () => number;
  /** Clock seam. */
  now?: () => Date;
}

export function monthBucketUTC(date: Date): string {
  return date.toISOString().slice(0, 7);
}

const EMPTY = (bucket: string, cap: number): OnlineEvalBudgetState => ({
  monthBucket: bucket,
  tokensUsed: 0,
  tokensCap: cap,
  calls: 0,
});

export class OnlineEvalBudget {
  private readonly dirFn: () => string;
  private readonly capFn: () => number;
  private readonly nowFn: () => Date;
  private state: OnlineEvalBudgetState | null = null;
  /** Directory the cached `state` was loaded from; a change invalidates it. */
  private stateDir: string | null = null;
  /** Serialises read-modify-write so two concurrent samples cannot both slip past a full ledger. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: OnlineEvalBudgetOptions) {
    this.dirFn = typeof opts.dir === "function" ? opts.dir : () => opts.dir as string;
    this.capFn = opts.cap;
    this.nowFn = opts.now ?? (() => new Date());
  }

  private dir(): string {
    return this.dirFn();
  }

  private file(): string {
    return path.join(this.dir(), "budget.json");
  }

  private async load(cap: number, bucket: string): Promise<OnlineEvalBudgetState> {
    const dir = this.dir();
    if (this.stateDir !== dir) {
      this.state = null;
      this.stateDir = dir;
    }
    if (this.state && this.state.monthBucket === bucket) {
      return { ...this.state, tokensCap: cap };
    }
    let parsed: OnlineEvalBudgetState | null = null;
    try {
      const raw = await fs.readFile(this.file(), "utf8");
      const candidate = onlineEvalBudgetStateSchema.safeParse(JSON.parse(raw));
      if (candidate.success) parsed = candidate.data;
    } catch {
      parsed = null;
    }
    // A ledger from a previous month starts over — the allowance is monthly.
    const next =
      parsed && parsed.monthBucket === bucket ? { ...parsed, tokensCap: cap } : EMPTY(bucket, cap);
    this.state = next;
    return next;
  }

  private async persist(state: OnlineEvalBudgetState): Promise<void> {
    this.state = state;
    this.stateDir = this.dir();
    await fs.mkdir(this.dir(), { recursive: true });
    await fs.writeFile(this.file(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  /** Serialise a mutation against the ledger. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    // Keep the chain alive even if a link rejects.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Debit `tokens` up front. Returns `allowed: false` without debiting when
   * the month's allowance is spent or no allowance is configured.
   */
  reserve(tokens: number): Promise<BudgetDecision> {
    return this.run(async () => {
      const cap = this.capFn();
      const bucket = monthBucketUTC(this.nowFn());
      const current = await this.load(cap, bucket);
      const want = Math.max(0, Math.trunc(tokens));

      if (cap <= 0) {
        return {
          allowed: false,
          reason: "NO_BUDGET_CONFIGURED" as const,
          reserved: 0,
          state: current,
        };
      }
      if (current.tokensUsed + want > cap) {
        return {
          allowed: false,
          reason: "MONTHLY_BUDGET_EXCEEDED" as const,
          reserved: 0,
          state: current,
        };
      }
      const next: OnlineEvalBudgetState = {
        monthBucket: bucket,
        tokensUsed: current.tokensUsed + want,
        tokensCap: cap,
        calls: current.calls + 1,
      };
      await this.persist(next);
      return { allowed: true, reason: "OK" as const, reserved: want, state: next };
    });
  }

  /**
   * Reconcile a reservation against what the judge actually spent. The ledger
   * never drops below zero and never below the reservations of other calls.
   */
  settle(reserved: number, actual: number): Promise<OnlineEvalBudgetState> {
    return this.run(async () => {
      const cap = this.capFn();
      const bucket = monthBucketUTC(this.nowFn());
      const current = await this.load(cap, bucket);
      const delta = Math.trunc(actual) - Math.trunc(reserved);
      if (delta === 0) return current;
      const next: OnlineEvalBudgetState = {
        ...current,
        tokensCap: cap,
        tokensUsed: Math.max(0, current.tokensUsed + delta),
      };
      await this.persist(next);
      return next;
    });
  }

  /**
   * Give back a reservation for a call that never completed (a judge error).
   * Unlike `settle(reserved, 0)` this also walks `calls` back, so the operator
   * counter reports **completed judge calls** rather than attempts — otherwise
   * it drifts upward with every judge failure.
   */
  refund(reserved: number): Promise<OnlineEvalBudgetState> {
    return this.run(async () => {
      const cap = this.capFn();
      const bucket = monthBucketUTC(this.nowFn());
      const current = await this.load(cap, bucket);
      const give = Math.max(0, Math.trunc(reserved));
      const next: OnlineEvalBudgetState = {
        ...current,
        tokensCap: cap,
        tokensUsed: Math.max(0, current.tokensUsed - give),
        calls: Math.max(0, current.calls - 1),
      };
      await this.persist(next);
      return next;
    });
  }

  /** Read-only view for the operator status endpoint. */
  status(): Promise<OnlineEvalBudgetState> {
    return this.run(async () => {
      const cap = this.capFn();
      return await this.load(cap, monthBucketUTC(this.nowFn()));
    });
  }
}
