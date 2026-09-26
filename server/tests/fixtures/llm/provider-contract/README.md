# Recorded provider-contract fixtures (#197)

Live wire traffic for the #132/#133 contract scenarios, replayed offline by
`server/tests/lib/ai/provider-contract-recorded.test.ts` through the real
adapters. One file per `<runtime>/<scenario>.json`:

| Runtime | Wire | Model | Recorded against |
| --- | --- | --- | --- |
| `deepseek` | Anthropic Messages | `deepseek-v4-pro` | `https://api.deepseek.com/anthropic` (thinking disabled) |
| `ollama` | OpenAI Chat Completions | `laguna-s-2.1` | Ollama 0.34.2 `/v1` on a LAN host (host scrubbed) |

OpenAI and Azure OpenAI are not recorded yet (no credentials); #197 tracks them.

Each file holds the scrubbed request/response exchanges (no headers are ever
stored; URLs keep path + query only), the `fixtureKey` of the scenario request
(a changed scenario fails as stale until re-recorded), and the adapter's parsed
result from the live run.

On replay the adapter's outgoing request must match the recorded one in its
contract fields (model, tool names, tool choice, response format, call/result
ids) **and its content**: system prompt, turn text, tool-call arguments and
tool-result content. Sampling knobs (`temperature`, `thinking`, `max_tokens`)
are not compared, so a change there does not force a paid re-record.

## Re-recording

Costs real API spend and needs the Ollama host; a maintainer runs it:

```bash
cd server
AI_RECORD=1 AI_RECORD_OVERWRITE=1 \
ANTHROPIC_API_KEY=… ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
LOCAL_GEMMA_BASE_URL=http://<ollama-host>:11434/v1 \
npx vitest run tests/lib/ai/provider-contract-recorded.test.ts
```

Drop `AI_RECORD_OVERWRITE` to fill only missing fixtures. A record run makes
exactly one attempt per request: the Anthropic SDK is built with
`maxRetries: 0`, the OpenAI-compatible client with `AI_MAX_RETRIES=1`, the test
itself does not re-run, and a fixture with a non-2xx exchange is refused. A runtime whose
credentials are absent is replayed, never recorded. Before committing, run
`node scripts/verify-no-company-identifiers.mjs`; the hygiene tests in the
same file also scan every fixture for keys, auth headers, cookies, private IPs
and UUID request ids.
