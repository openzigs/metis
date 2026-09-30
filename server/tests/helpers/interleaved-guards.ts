/**
 * #479 / #495 — the guard wrapper for `conditional-binding-update-suite.ts`.
 *
 * A module of its own, importing nothing: a `vi.mock` factory imports it, and
 * the suite module would pull in the very guard modules being mocked.
 */
export interface BindingSuiteState {
  db: unknown;
  /** Runs once, after a guard returns and before the service writes. */
  between: null | (() => Promise<void>);
  /** Runs once, after a vault secret is created and before the row is written. */
  afterVaultCreate: null | (() => Promise<void>);
  /**
   * #577 — optional: replaces guard `name`'s result before the route sees it,
   * so a suite can hand the write a checked set that misses a reference.
   */
  rewrite?: null | ((name: string, result: unknown) => unknown);
}

/** Wrap every guard export so `state.between` fires after the real guard returns. */
export function interleaved(
  actual: Record<string, unknown>,
  state: BindingSuiteState,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = { ...actual };
  for (const [name, fn] of Object.entries(actual)) {
    if (typeof fn !== "function" || !/^assert\w+SecretBinding$/.test(name)) continue;
    wrapped[name] = async (...args: unknown[]) => {
      const result = await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
      const hook = state.between;
      state.between = null;
      if (hook) await hook();
      return state.rewrite ? state.rewrite(name, result) : result;
    };
  }
  return wrapped;
}
