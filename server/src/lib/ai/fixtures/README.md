# Record/replay LLM fixture harness (#234)

Deterministic record/replay for the METIS LLM seam. Lets generative paths run
end-to-end in CI **without live LLM credentials**, while a maintainer can refresh
the fixtures against a real model on demand.

It sits on the existing `AIProvider.chat()` seam — there is **no new AI
dependency** and no Vercel AI SDK. All calls still flow through the
`@github/copilot-sdk`-backed provider abstraction.

## How it works

- **`fixtureKey(messages, opts)`** — content-addressed SHA-256 of the request
  (messages + the response-affecting subset of `ChatOptions`). Volatile options
  (`signal`, `sessionId`, `skillDirectories`, …) are excluded so a recording made
  on one machine replays on another.
- **`RecordingProvider`** — wraps the real provider, passes `chat()` through, and
  writes each response to `<fixtureDir>/<key>.json`.
- **`ReplayProvider`** — implements `AIProvider`; serves `chat()` from fixtures and
  synthesises `stream()` from the recorded content. On a miss it falls back to the
  `OfflineStubProvider` (or throws `ReplayFixtureMissError` if no fallback).
- **`maybeWrapProviderForFixtures(provider)`** — the single env-driven seam the
  server uses. Wired into `buildProvider()` (`providers/factory.ts`) and the
  Bedrock-direct branch in `server.ts`.

## Environment flags (read by the running server)

| Variable | Effect |
| --- | --- |
| `AI_REPLAY=1` | Serve `.chat()` from fixtures. No LLM credentials needed. **Wins if both flags set.** |
| `AI_RECORD=1` | Pass through to the real provider and capture responses. Requires real credentials. |
| `AI_FIXTURE_DIR` | Fixture directory. Default `tests/fixtures/llm` (relative to the server cwd). Shared by both modes. |
| `AI_RECORD_OVERWRITE=1` | In record mode, refresh fixtures that already exist (otherwise only gaps are filled). |

## Recording fixtures

Run the server (or a script) with real credentials and record mode, exercising
the path you want to capture:

```bash
AI_RECORD=1 \
AI_FIXTURE_DIR="$PWD/e2e/fixtures/llm" \
AI_PROVIDER=bedrock-gateway \
pnpm --filter @metis/server start   # then drive the generative path once
```

Fixtures are written as readable JSON (`key`, `request.promptPreview`, `response`).
Commit them. To refresh after a prompt change, re-run with `AI_RECORD_OVERWRITE=1`.

## Replaying in CI / Playwright e2e

Start the server with replay mode pointed at the committed fixture directory:

```bash
AI_REPLAY=1 AI_FIXTURE_DIR="$PWD/e2e/fixtures/llm" pnpm --filter @metis/server start
```

The server installs the `ReplayProvider` automatically — no LLM keys required.
Any request whose `chat()` payload matches a recorded fixture replays
deterministically; unrecorded requests fall back to the offline stub.

### From a Playwright spec (`e2e/`)

The harness is importable for assertions / pre-seeding fixtures:

```ts
import { ReplayProvider, FixtureStore, fixtureKey, resolveFixtureDir }
  from "../../server/src/lib/ai/fixtures/index.js";
```

The recommended pattern for #235 is to set `AI_REPLAY=1` + `AI_FIXTURE_DIR` in the
Playwright web-server env (`playwright.config.ts` / `global-setup.ts`) so the
server under test uses replay, then assert on the resulting persisted state.
