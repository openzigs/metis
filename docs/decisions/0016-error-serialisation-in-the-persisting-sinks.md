# 0016 — The persisting redaction sinks do not serialise Errors; callers reduce at the boundary

- **Status**: Accepted
- **Date**: 2026-09-22
- **Issue**: [#85](https://github.com/openzigs/metis/issues/85)
- **Relates to**: [#68](https://github.com/openzigs/metis/issues/68) (the logger repair this
  declines to copy), [ADR 0008](0008-redaction-sinks.md) (the sink registry and the
  one-shared-predicate decision it extends)

## Context

`redact()` in all three of METIS's redaction sinks rebuilds every object from
`Object.entries(...)`. An `Error`'s `name`, `message`, `stack` and `cause` are own but **not
own enumerable** properties, so every one of the three turns a thrown error into `{}` plus
whatever own *enumerable* properties it happens to carry.

[#68](https://github.com/openzigs/metis/issues/68) fixed that in `logger.ts` by enumerating
those four keys explicitly. #85 found the same class one level down — `AggregateError.errors`
has the identical descriptor and was not on the list, so every `Promise.any` /
batched-connector rejection logged an aggregate with no sub-errors — and asked the question
#68 deliberately left open:

> Both [audit sinks] **persist** what they serialise, so writing stacks there is a product
> decision (retention, PII) rather than an obvious fix.

The two sinks in question:

| Sink | Persisted as | Audience |
| --- | --- | --- |
| `server/src/lib/audit/audit-service.ts` | `AuditLog` rows | compliance, export |
| `server/src/lib/sandbox/audit/redact.ts` | `SandboxAuditEvent` rows | SOC 2 evidence, forensics |

ADR 0008 already warned against the shape of the wrong answer here: *"changing a sink's
policy with no observed defect is how the next fail-open gate gets written."*

## Decision

**No. Neither persisting sink serialises an `Error`. Callers reduce an error to a message or
a code at the boundary, and both sinks declare
`ERROR_SERIALISATION_POLICY: reduce-at-call-site` in-file.**

Three reasons, in the order they carried weight:

1. **The evidence says nothing reaches them.** Every `audit({...})` call site in `server/src`
   already reduces its error before the sink sees it — `(err as Error).message`,
   `toConnectorError(err).code`, `error.slice(0, 200)`. So does the sandbox emitter's own
   failure path. This is a claim about the source, so it is read off the source: a new block
   in `server/tests/redaction-sinks.enumeration.test.ts` scans every audit call and every
   `emitter.emit(...)` for a bare error in value position and fails if one appears. It found
   zero when this ADR landed.
2. **A stack is a cost in a retained row, not a feature.** `stack` carries absolute server
   paths; `cause` chains an arbitrary provider payload (response bodies, SQL text) into a row
   that is exported to auditors and, by design, never edited afterwards. The logger's
   transport is rotated and operator-facing, which is exactly why the same content is right
   there and wrong here. This is the retention/PII judgement #68 declined to make silently.
3. **The call site knows what the record is for.** `audit()` rows answer "who did what to
   which resource, and did it succeed". A caller that wants a reason already writes one
   (`code: ce.code`, `errorMessage: message`). Widening the sink would let a future caller
   dump an exception into a compliance row by accident rather than by decision.

Redaction is unaffected in either sink: an Error's own enumerable properties are still walked
by the same key rules as any other object, so the policy is *record less*, never *skip
redaction*. `accessToken` hung off an error still reads `[REDACTED]`.

## Consequences

- `logger.ts` declares `ERROR_SERIALISATION_POLICY: serialise-errors`; both persisting sinks
  declare `reduce-at-call-site`. `redaction-sinks.enumeration.test.ts` requires every
  registered sink to carry a recognised marker on **both** axes and fails if the two
  registries name different files — a sink added to one and not the other would be unchecked
  on that axis while everything else stayed green.
- The behaviour is pinned by assertions, not only by a comment:
  `server/tests/audit-redaction.test.ts` and `server/tests/lib/sandbox/audit/redact.test.ts`
  each assert that an Error yields no `name` / `message` / `stack` / `cause` / `errors`, and
  that a credential hung off it still redacts. Copying the #68 repair into either file by
  analogy now goes red and names this file.
- **The premise is re-checked, not assumed.** If a call site ever does hand a sink an Error,
  the enumeration test fails with the file and line, and the next person re-decides on that
  evidence — the same construction ADR 0008 used for the sandbox sink's token-count opt-out.
- **Stated boundary, because the acceptance criterion asks for a decision and not for a claim
  of closure.** The premise scan recognises a bare error identifier in value position
  (`error: err`), the object shorthand (`{ err }`) and a freshly constructed error
  (`cause: new Error(...)`). It does **not** recognise an error reached through an alias
  several statements earlier (`const detail = err; audit({ metadata: { detail } })`), nor one
  spread in (`...err`) — a spread would carry only the enumerable properties the sinks
  already redact, which is why it is out of scope rather than merely unhandled. A positive
  control in the same block asserts the detector fires on three planted call sites, so
  deleting a pattern cannot read as "the premise holds".

## Alternatives rejected

- **Serialise `name` and `message` but not `stack`.** The tempting middle. Rejected because
  it is a policy change to two persisted sinks that no observed defect motivates (ADR 0008's
  own warning), and because it would make the *sink* the place that decides how much of a
  failure a compliance record keeps — the decision that belongs to the call site, which knows
  what the row is for. Nothing is lost today: no call site passes an Error at all.
- **Copy the #68 repair verbatim into both sinks.** Symmetry for its own sake, and the
  expensive direction of a mistake: a stack in an exported `AuditLog` row cannot be recalled
  by a later commit.
- **Leave it undocumented as "obviously not a bug".** This is the third time the
  `Object.entries` rebuild has been read as a defect (#68, then #85's first arm, then this
  question). An unmarked sink invites a fourth reader to fix it by analogy with the logger.
