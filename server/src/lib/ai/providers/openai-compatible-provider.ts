/**
 * Canonical entry point for the shared OpenAI-compatible HTTP provider (#110).
 *
 * The implementation lives in `bedrock-direct-provider.ts` for git-history
 * continuity (it began life as the Bedrock-only client). New code should
 * import {@link OpenAICompatibleProvider} from here; the Bedrock interception
 * path keeps using the `BedrockDirectProvider` alias from the original module.
 *
 * **This file is a re-export shim — it deliberately contains no logic.** That
 * has misled readers before (#1115): grepping this file for `response_format`
 * finds nothing and looks like the structured-output support advertised on
 * `ChatOptions.responseFormat` is missing. It is not. `OpenAICompatibleProvider`
 * IS `BedrockDirectProvider` — one class, two exported names — and it is the
 * only adapter that forwards `response_format` to the backend (#336, with a
 * one-shot degrade retry). Its behaviour is pinned by
 * `openai-compatible-structured-output.test.ts` in this directory, which
 * imports through this entry point, and its capability declaration is pinned by
 * `provider-capabilities.test.ts`.
 */
export {
  OpenAICompatibleProvider,
  BedrockDirectProvider,
  FirstTokenTimeoutError,
  LOCAL_TIMEOUT_ENV,
  isCrossRegionModelId,
  isStructuredOutputUnsupportedStatus,
  isTemperatureUnsupportedBody,
  resolveUndiciTimeouts,
  type OpenAICompatibleProviderOptions,
  type BedrockDirectProviderOptions,
} from "./bedrock-direct-provider.js";
