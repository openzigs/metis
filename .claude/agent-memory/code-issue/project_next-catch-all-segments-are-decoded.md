---
name: project_next-catch-all-segments-are-decoded
description: a Next catch-all segment arrives decoded and can hold / \ or ?, so proxy policy must read the resolved upstream pathname
metadata:
  type: project
---

Next decodes each catch-all route segment, so in ui/src/app/api/[...path]/route.ts one path element can contain /, \\ or ?, and new URL then normalises it to a different upstream route. Any per-route policy in that proxy (timeouts, allowlists, auth exceptions) must be decided from the resolved upstreamUrl.pathname, never from the raw segments, and tests must feed a segment such as '../../../../chat/stream' rather than path.split('/').

**Why:** on #1069 the Spec Kit timeout matcher read five raw segments, and `/api/projects/p1/spec-kit/commands/..%2F..%2F..%2F..%2Fchat%2Fstream` gave `POST /api/chat/stream` the 15-60 minute timeout. Every matcher and route test was green because each built `path` with `path.split("/")`, which can never produce a segment holding a slash. A code review found it against a running Next 16.3.8 server; the three-lens adversarial panel did not. The same join had let `..%2F` walk out of `/api` to `POST /health` on `main`.

**How to apply:** the route now refuses (400) a segment that holds `/`, `\`, `?`, `#` or a control character, or is a dot segment (`%2e` spellings included: `new URL` resolves those, and strips tab/CR/LF so `".\t."` becomes `".."`), then takes `pathBelowUpstreamBase(upstreamUrl, base)` and decides `/auth` and the timeout from that (`ui/src/lib/proxy-upstream.ts`). Add new per-route rules after that call, on its return value. In tests pass `params.path` as hand-written decoded strings. No UI caller sends an encoded slash in a path segment (checked 2026-10-11): nested Spec Kit keys are split on `/` before encoding.
