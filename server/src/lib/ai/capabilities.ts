/**
 * Provider capability declarations (#1115).
 *
 * ## Why this exists
 *
 * {@link ChatOptions} is a union of every option any adapter might honour, but
 * an adapter that does not honour one has historically just ignored it. That is
 * an invisible cliff: before this module, calling code could pass
 * `responseFormat` to the `anthropic` provider (the currently configured one),
 * get no error, and silently receive unconstrained text — while the same code
 * against `bedrock-gateway` got schema-constrained JSON. "Works on my
 * deployment" bugs are made of exactly this.
 *
 * The fix is not to implement every option everywhere (see the "Explicitly out
 * of scope" section of epic #1107 — full `json_schema` parity is its own
 * project). The fix is to make support **discoverable**, so a caller can branch
 * instead of guessing.
 *
 * ## The contract
 *
 * Every adapter declares a static {@link ProviderCapabilities} record on
 * `AIProvider.capabilities`. Callers MUST read it through {@link providerSupports}
 * (or the {@link supportsResponseFormat} shorthand) rather than touching the
 * field directly, because those helpers encode the safe default:
 *
 * > **An adapter that declares nothing supports nothing.**
 *
 * Absence therefore degrades to the free-form path — it never asserts a
 * capability the adapter may not have. That is why `capabilities` is optional
 * on the interface: a stub or test double that omits it is read as "no
 * support", which is honest, whereas a required field would have forced dozens
 * of test doubles to assert capabilities they never exercise.
 *
 * ## Making the drop audible
 *
 * Discoverability helps callers that ask. For callers that do not,
 * {@link createUnsupportedResponseFormatWarner} lets a non-supporting adapter
 * log — once per instance — that it received and dropped a `responseFormat`.
 * The request still succeeds (dropping is not fatal; the caller's JSON
 * parse/repair path handles it), but the drop is no longer silent.
 *
 * ## Consumers
 *
 * #1114 ("reliable structured verdicts across providers") is the first
 * consumer: it uses `responseFormat` opportunistically where supported and
 * falls back to parse-and-retry everywhere else. Treat this module as a stable
 * seam — add capabilities, do not rename the helpers.
 */

/**
 * What an adapter actually honours, declared by the adapter itself.
 *
 * Add a field here only when at least one adapter genuinely implements the
 * behaviour AND a caller needs to branch on it. Every field is a plain boolean
 * — the probe is static (what the adapter's code does), never a live network
 * check, so it is safe to read on a hot path.
 */
export interface ProviderCapabilities {
  /**
   * `true` ⇒ `chat()`/`stream()` forward {@link ChatOptions.responseFormat} to
   * the backend as a schema constraint the runtime enforces.
   *
   * `false` ⇒ the option is dropped. The call still succeeds and returns
   * free-form text, so callers that need JSON must parse and repair it
   * themselves.
   */
  responseFormat: boolean;
  /**
   * `true` ⇒ the adapter surfaces the backend's **native** tool-call channel as
   * `{ type: "tool_call" }` chunks — structured events emitted by the API, not
   * text scraped out of prose.
   *
   * `false` ⇒ any tool call the caller sees came from
   * `providers/tool-tag-parser.ts`, which recovers `<tool_call>` XML that a
   * model improvised into its visible output. That parser is a symptom of this
   * capability being absent, not a substitute for it.
   *
   * NOTE: this describes the *channel*, not caller-supplied tools. METIS does
   * not currently register tools with any provider SDK; `ChatOptions` has no
   * field for them.
   */
  nativeToolCalls: boolean;
}

/** Every capability name, for callers that want to enumerate or key on them. */
export type CapabilityName = keyof ProviderCapabilities;

/**
 * The honest default for an adapter that implements none of the optional
 * capabilities. Frozen so a shared reference cannot be mutated by one adapter
 * and observed by another.
 */
export const NO_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  responseFormat: false,
  nativeToolCalls: false,
});

/**
 * The minimum shape {@link providerSupports} needs. Deliberately structural
 * rather than `AIProvider` so this module stays free of import cycles and so
 * tests can probe a bare `{ capabilities }` literal.
 */
export interface CapabilityProbeTarget {
  readonly capabilities?: ProviderCapabilities;
}

/**
 * The capability probe. Returns `true` only when `provider` explicitly declares
 * `capability` as supported.
 *
 * A missing provider, a missing `capabilities` record, or a `false` entry all
 * return `false` — the safe direction. Never read `provider.capabilities?.x`
 * inline; go through here so the default stays in one place.
 *
 * @example
 * const opts: ChatOptions = { model };
 * if (providerSupports(provider, "responseFormat")) opts.responseFormat = SCHEMA;
 */
export function providerSupports(
  provider: CapabilityProbeTarget | null | undefined,
  capability: CapabilityName,
): boolean {
  return provider?.capabilities?.[capability] === true;
}

/**
 * Shorthand for the capability callers ask about most (#1114).
 *
 * @returns `true` when `ChatOptions.responseFormat` will actually reach the
 *   backend; `false` when supplying it would be a silent no-op.
 */
export function supportsResponseFormat(
  provider: CapabilityProbeTarget | null | undefined,
): boolean {
  return providerSupports(provider, "responseFormat");
}

/** The subset of a logger this module needs. */
export interface CapabilityWarnLogger {
  warn: (msg: string, meta?: unknown) => void;
}

/**
 * Build a once-per-instance notifier that an adapter without
 * `responseFormat` support calls at the top of `chat()`/`stream()`.
 *
 * Once-only because a verification run makes ~135 provider calls; a per-call
 * warn would bury the signal it is meant to raise. The caller's schema is never
 * logged — only the fact that one was supplied and dropped.
 *
 * @param log logger to emit on (typically the adapter's child logger)
 * @param providerKey adapter identity, included in the log meta
 * @returns a function to call with `opts.responseFormat` on every request
 */
export function createUnsupportedResponseFormatWarner(
  log: CapabilityWarnLogger,
  providerKey: string,
): (responseFormat: unknown) => void {
  let warned = false;
  return (responseFormat: unknown): void => {
    if (responseFormat == null || warned) return;
    warned = true;
    log.warn(
      "Ignoring ChatOptions.responseFormat — this provider does not support schema-constrained output; " +
        "the response will be free-form text. Probe with providerSupports(provider, 'responseFormat') to branch.",
      { provider: providerKey, capability: "responseFormat" },
    );
  };
}
