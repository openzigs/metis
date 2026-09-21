# 8. Redaction sinks: one shared exemption predicate, per-sink policy

Date: 2026-08-06
Status: Accepted
Issue: #1268 (follows #1263, #1225)

## Context

METIS had **three independent key-redaction lists**, each carrying its own copy of
`SENSITIVE_KEY_PATTERNS` including `/token/i`:

| Sink | File | Persisted? | Audience |
| --- | --- | --- | --- |
| Application logs | `server/src/lib/logger.ts` | no (shipped, rotated) | operators |
| Audit records | `server/src/lib/audit/audit-service.ts` | **yes** (`AuditLog` rows) | compliance, export |
| Sandbox audit | `server/src/lib/sandbox/audit/redact.ts` | **yes** (`SandboxAuditEvent` rows) | compliance, forensics |

`/token/i` was written to catch `access_token` / `bearer_token`. It also blanked every
token *count*, so all token accounting in all three sinks read `[REDACTED]`. #1263 fixed
the logger with an enumerated allowlist of count keys whose value must be numeric. The
other two were deliberately left for this decision, because a discriminator that is right
for a transient operator-facing log is not automatically right for a persisted record.

The cost of leaving it implicit was already paid: `custom-agents/invocation-audit.ts`
renamed `promptTokens` → `promptUsage` (and two siblings) **to dodge the audit redactor**,
so the field names in a SOC 2 audit row stopped matching the field names everywhere else
in the repo — and a test asserted the renamed shape, pinning the workaround in place.

## Decision

**One shared exemption predicate; each sink keeps its own denylist and declares, in the
file, whether it consults the exemption.**

- The shared predicate is `isTokenCountExempt(key, value)`, exported from `logger.ts`,
  where the enumerated count allowlist already lives and is already maintained. It answers
  one question: *is this key an enumerated token count carrying a value that cannot hold a
  secret?* That is a fact about the key and the value, **not about the sink** — which is
  why three copies of it drift.
- Whether a sink applies that exemption **is** per-sink policy, and is written into each
  sink as a `REDACTION_SINK_POLICY:` marker that a test reads.
- The denylists stay per-sink. They genuinely differ: the sandbox sink also redacts
  `content`, `body`, `data` and `sessionId`, which are not credential-shaped at all.

### Per-sink policy

| Sink | Policy | Reason |
| --- | --- | --- |
| `logger.ts` | `exempt-token-counts` | #1263. Token accounting is the point of the log line. |
| `audit/audit-service.ts` | `exempt-token-counts` | A count is not a credential, and persistence raises the cost of leaking a *credential*, not of recording a count. Token spend is exactly the accounting an audit record exists to carry — it is per-actor, per-target attributable spend, which is why the workaround was written rather than the field dropped. |
| `sandbox/audit/redact.ts` | `no-token-count-exemption` | **No count reaches this sink.** All 24 payload keys emitted by the four sandbox providers are enumerated by `redaction-sinks.enumeration.test.ts`; none matches `/token/i`. This sink also redacts by *category* (`content`, `body`, `data`) rather than by secrecy, and its free-text `command` values carry literal bearer tokens from callers, so it is deliberately the broadest of the three. Changing a sink's policy with no observed defect is how the next fail-open gate gets written. |

If a token count ever does reach the sandbox sink, the enumeration test fails and the next
person makes that decision on evidence rather than by copying this one.

## Consequences

- The `invocation-audit.ts` rename workaround is removed; the audit row carries
  `promptTokens` / `completionTokens` / `totalTokens` under their real names again.
- **A fourth copied list is caught, within a stated boundary.**
  `redaction-sinks.enumeration.test.ts` scans `server/src` for any module declaring a
  credential-shaped regex denylist, and fails unless every declaring file is one of the
  three registered above *and* carries a recognised `REDACTION_SINK_POLICY:` marker. A new
  sink must register and choose.

  The boundary, stated because the issue's acceptance criterion asks for it rather than for
  a claim of closure: the gate recognises **three or more regex literals in array-member
  position, at least one credential-shaped**, in either Prettier formatting (one per line,
  or all on one line — the adversarial panel caught the first draft accepting only the
  former, which is a fail-open in a test written to close one). It does **not** recognise a
  denylist built from *string* literals (`["token", "secret"]`) or assembled at runtime via
  `new RegExp(...)` — the latter is separately blocked by the repo's Semgrep
  `non-literal-regexp` rule, the former is not caught at all. A determined fourth copy in
  that shape still gets through; a copy-paste of one of these three does not, and
  copy-paste is the failure this defect actually came from.
- The exemption still fails closed everywhere it is applied: a key is exempt only if it is
  **named** in the allowlist **and** carries a numeric (or absent) value, so a new
  credential-shaped key redacts by default and a mistaken allowlist entry cannot leak a
  string credential. `tokens: 4096` survives; `tokens: "<credential>"` does not.
- `tokenId` (`server/src/lib/acp/server.ts`) stays redacted in every sink: it is a handle
  to a verified bearer token, not a count.
- **Known and deliberate:** `server/src/routes/ai.ts` passes `tokens: aggregateUsage` — a
  `TokenUsage` *object*, not a number — to the `ai.chat` and `ai.stream` audit rows, so
  those two still persist `[REDACTED]`. The numeric-value clause is doing exactly its job:
  an object under an allowlisted name could hold anything, and widening the exemption to
  recurse into it is a policy change on a persisted sink that no observed defect motivates.
  The fix, when someone wants those counts, is at the call site — spread the three counts
  as sibling keys — not in the guard.

## Alternatives rejected

- **Three deliberately independent lists.** Defensible on threat-model grounds, and the
  denylists *are* kept independent for exactly that reason. But the token-count question
  has one right answer per key, and letting three files answer it separately is what
  produced a rename workaround instead of a fix.
- **One list for everything.** Would force the sandbox sink to stop redacting `content` /
  `body` / `data`, or force those onto the logger — a policy change in both directions
  driven by nothing but a wish for symmetry.
- **Moving the count allowlist out of `logger.ts` into a new shared module.** Correct in
  the abstract, but the allowlist is under active concurrent edit (#1257 adds thinking- and
  reasoning-token keys). Exporting one predicate from where the list already lives costs a
  six-line diff; relocating the list costs a conflict.
