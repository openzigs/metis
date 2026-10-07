/**
 * #754 — the ONE way to wrap an {@link AIProvider} while overriding a few of
 * its members (metering, deadlines, …).
 *
 * A hand-built wrapper object has to restate every member it does not
 * override, and the optional ones (`capabilities`, `capabilitiesFor`,
 * `servesRouterModel`) are exactly the ones that get forgotten: capability
 * resolution then reads the wrapper as "supports nothing" and every caller
 * silently loses structured output and caching. A `Proxy` cannot forget —
 * anything not in `overrides` reaches the wrapped adapter unchanged, and an
 * absent optional member stays absent.
 */
import type { AIProvider } from "./types.js";

/** Members to replace on the wrapped provider; symbol keys are allowed for markers. */
export type ProviderOverrides = Partial<AIProvider> & { [marker: symbol]: unknown };

/**
 * Return a provider that answers `overrides` first and forwards every other
 * member to `provider`. Forwarded methods are bound to `provider`, so an
 * adapter's internal `this.chat()` reaches the adapter itself, never the
 * override (which would otherwise meter that call twice).
 */
export function decorateProvider(provider: AIProvider, overrides: ProviderOverrides): AIProvider {
  return new Proxy(provider, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return (overrides as Record<PropertyKey, unknown>)[prop];
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
    has(target, prop) {
      return Object.prototype.hasOwnProperty.call(overrides, prop) || Reflect.has(target, prop);
    },
  });
}
