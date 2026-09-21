# impact-recall-02-shared-db — cross-project shared-table impact corpus

Second impact-recall eval corpus (**#959**, epic **#954**). Where
`impact-recall-01-jpetstore` measures single-project requirement→(code, tables)
recall/precision, this corpus measures the **cross-project consumer** signal: when
N applications share one physical database, an impact run should flag **which
OTHER applications also read/write the affected tables**.

## Scenario

Two small applications run over **one** physical database and share two tables:

| Project (`projectId`)          | Package        | Tables it touches                 |
| ------------------------------ | -------------- | --------------------------------- |
| `impact-recall-02-storefront`  | `org.shop.*`   | `account` (r/w), `orders` (r/w), `cart` (private) |
| `impact-recall-02-reporting`   | `com.report.*` | `account` (r), `orders` (r), `report_run` (private) |

**Shared tables:** `account`, `orders` (touched by both projects).
**Private tables:** `cart` (storefront only), `report_run` (reporting only).

Every labeled requirement originates in the storefront. Each shared-table
requirement declares an `expectedConsumers` list naming the **reporting** app —
the other project an impact run should flag. The private-table requirement
(`REQ-03`, `cart`) declares **no** `expectedConsumers` key, so it is not
consumer-scored.

The graph is deliberately **small and un-polluted** (mapper-only, no cross-layer
service fan-out) so it isolates the cross-project consumer signal — corpus-01
already carries the seed-pollution realism.

## Running

```bash
pnpm eval:impact-recall --corpus impact-recall-02-shared-db          # gated on floors
pnpm eval:impact-recall --corpus impact-recall-02-shared-db --md     # + Markdown report
pnpm eval:impact-recall --corpus impact-recall-02-shared-db --no-fail
```

Deterministic: no network, no live LLM, no DB. All LLM-gated flags default OFF
(BM25 seeding, no output filter, no consumer resolver).

## Honest baseline (pre-#955 / #956)

Measured 2026-07-20 (BM25, no LLM, **no consumer resolver wired**):

| Dimension | Macro recall | Macro precision |
| --------- | ------------ | --------------- |
| Tables    | 1.00         | 1.00            |
| Code      | 1.00         | 0.67            |
| **Consumers** | **0.00** | **1.00 (vacuous)** |

The consumer numbers are the **load-bearing baseline**: the impact engine does
**not yet** surface cross-project consumers (`SchemaObjectIdentity` reconciliation
has zero production callers, and the string-match fallback is not invoked by
`POST /api/impact-analyses` — see epic #954's verified findings). So every
expected consumer is a **MISS** (recall `0.00`), and precision is a **vacuous
`1.00`** — nothing was surfaced, so nothing surfaced was wrong.

This is the **yardstick**: when **#955** (wire identity reconciliation) and
**#956** (surface consumers in impact results) land, the *same* command must show
consumer recall climb off `0.00`. The lift is then **measured, not asserted**.

`code` precision is `0.67` (not `1.00`) because DAO-sibling seeding surfaces both
the `get*` and the `update`/`insert*` method of a mapper when the entity token
(`account`/`order`) seeds it — an honest over-broad code symbol on `REQ-01`/`REQ-02`.

### Thresholds (regression floors)

Per the **#939 precedent**, floors sit **at or below** the honest measured values,
never above (`DEFAULT_IMPACT_RECALL_THRESHOLDS_SHARED_DB` in
`server/src/lib/eval/impact-recall/runner.ts`):

- `consumerRecall` floored at **0** — locks in "no false claim of resolution"
  until #955/#956 wire it; lift the floor to the new measured recall when they land.
- `consumerPrecision` floored at **0**, deliberately **not** the vacuous `1.00` —
  flooring a never-surfaced metric at `1.00` would green-wash it.
- `tablePrecision` / `codePrecision` floored below the measured `1.00` / `0.67`.

## How consumers are (not) resolved here

The harness derives ground-truth shared-table consumers from the manifest
(`computeSharedTableConsumers` in `fixture.ts`), but the **runner never uses that
ground truth to seed `foundConsumers`** — doing so would green-wash the baseline.
`foundConsumers` comes only from an injected `consumerResolver` (absent by
default), which is the exact seam #955/#956 will wire with the real identity /
string-match rollup.
