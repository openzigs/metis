/**
 * Epic #473 / Issue #481 — Token budget enforcement.
 *
 * Tracks cumulative token usage across agent loop turns. Throws
 * BudgetExhaustedError when the configured maximum is exceeded so the
 * loop can gracefully emit partial findings.
 */

export class BudgetExhaustedError extends Error {
  readonly code = "BUDGET_EXHAUSTED";
  constructor(
    public readonly consumed: number,
    public readonly budget: number,
  ) {
    super(`Token budget exhausted: consumed ${consumed} of ${budget} allowed tokens`);
    this.name = "BudgetExhaustedError";
  }
}

export interface TokenBudgetOptions {
  /** Maximum total tokens allowed across all turns. */
  maxTokens: number;
}

export class TokenBudget {
  private consumed = 0;
  private readonly max: number;

  constructor(opts: TokenBudgetOptions) {
    this.max = opts.maxTokens;
  }

  /** Record tokens used in a turn. Throws if budget exceeded. */
  record(tokens: number): void {
    this.consumed += tokens;
    if (this.consumed > this.max) {
      throw new BudgetExhaustedError(this.consumed, this.max);
    }
  }

  /** Check if there's budget remaining without recording. */
  hasRemaining(): boolean {
    return this.consumed < this.max;
  }

  /** Tokens consumed so far. */
  get used(): number {
    return this.consumed;
  }

  /** Total budget. */
  get total(): number {
    return this.max;
  }

  /** Fraction of budget remaining (0-1). */
  get remainingFraction(): number {
    return Math.max(0, (this.max - this.consumed) / this.max);
  }
}
