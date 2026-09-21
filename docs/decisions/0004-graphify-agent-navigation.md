# 4. graphify is kept for humans and CI, and removed from agent instructions

Date: 2026-07-29
Status: Accepted
Issue: #1143 (epic #1141)

> **Correction, 2026-07-30 (#1168).** This ADR's text — including "Agents use
> `Grep`/`Glob`/`Explore`" in the Decision below, and the counterfactual's description of
> the native tools "an agent has by default" — was written when `Grep` and `Glob` were
> believed callable. They are not: this Claude Code build does not **expose** those names to
> any agent, and `agents:verify` now rejects the declaration. The decision text is left as
> written, because it records what was decided and what the arms were at the time. Read the
> winning arm as **`grep`/`find` via `Bash`, or `Explore`**, which is what `CLAUDE.md`
> instructs today. The comparison against graphify is unaffected — the arm's cost was
> measured as search-tool output, not as a property of the tool's name.

> **Superseded in part, 2026-08-02 (#1152).** Decision point 2 below — "Keep `graphify-out/`
> tracked … The retained rule that branches must never commit a regenerated `graph.json`
> (#916) stays" — no longer holds. `graphify-out/` is now untracked and gitignored, the CI
> refresh workflow is deleted, and the #916 rule is *removed* because violating it became
> impossible. Two premises this ADR asserted without testing were also falsified: that
> `GRAPH_REPORT.md` is "a human codebase overview" worth keeping (measured at ~3% signal,
> with 164 unlabelled `Cohesion: 0.0` communities and a fabricated "Surprising Connections"
> entry), and, implicitly, that the treadmill was a `graph.json` problem (the report is
> rewritten by 100% of refresh runs against the graph's 60%). Points 1, 3 and 4 — remove the
> navigation instruction, de-recommend `graphify path`, delete the hook — stand unchanged.
> See [0007-untrack-the-graphify-artifact.md](0007-untrack-the-graphify-artifact.md).

## Context

`CLAUDE.md` devoted ~28% of its bytes — roughly 900 tokens, paid on **every** non-Explore
subagent delegation — to instructing agents to navigate the codebase via the graphify
knowledge graph rather than grep. It went further than "consider it": it told agents that
answering a reachability question "with grep + inference is **strictly weaker evidence**"
than `graphify path`.

Nobody had ever tested that claim. This decision records the test.

## The counterfactual

Ten structural questions, taken verbatim from the work of recent issues, answered twice —
once through graphify, once through the native `Grep`/`Glob` tools an agent has by default.
Tokens are the **output an agent must pull into context**, measured as UTF-8 output bytes
÷ 4. The graph used was `origin/main`'s, freshly built (13,251 nodes) — not a stale
checkout. graphify 0.5.6, re-confirmed on 0.9.30.

Native searches are counted honestly, including failed first attempts: Q2 needed three
tries and Q3 and Q5 needed two, and every one of those wasted calls is billed below.

| # | Question | graphify | tok | ✓ | native | calls | tok | ✓ |
|---|----------|----------|----:|:-:|--------|:-----:|----:|:-:|
| Q1 | What does the draft generator read? (#1116) | `explain "draft-generator.ts"` | 306 | ✅ | glob + `rg -n '^import'` | 2 | 156 | ✅ |
| Q2 | Where does requirement block-splitting happen? (#1136) | `query "requirement block splitting split blocks"` | 1,525 | ❌ | 3 × `rg` | 3 | 298 | ✅ |
| Q3 | What mounts the requirements router? (#1118) | `query "requirements router mount express app use"` | 1,525 | ❌ | 2 × `rg` | 2 | 137 | ✅ |
| Q4 | What calls `applySupportPanel`? (#1109) | `explain "applySupportPanel"` | 108 | ❌ | `rg -n` scoped | 1 | 218 | ✅ |
| Q5 | Does `clarification-enrichment.ts` reach `draft-generator.ts`? | `path A B` | 65 | ❌ | 2 × `rg` | 2 | 149 | ✅ |
| Q6 | Where is `RateLimitStore`, and who implements it? (#541) | `query "RateLimitStore rate limit store backend"` | 1,525 | ✅ | `rg -l` | 1 | 343 | ✅ |
| Q7 | What calls `approveDraft`? (#1072) | `explain "approveDraft"` | 104 | ❌ | `rg -n` scoped | 1 | 122 | ✅ |
| Q8 | Where is the impact table-relevance filter, and what imports it? (#936) | `query "impact table relevance filter"` | 1,522 | ❌ | `rg -l` | 1 | 78 | ✅ |
| Q9 | Where is `classifyPrivateIp`, and who uses it? (#683) | `explain "classifyPrivateIp"` | 119 | ⚠️ | `rg -n` scoped | 1 | 134 | ✅ |
| Q10 | Which routers are protected by `requireProjectAccess`? (#674) | `query "requireProjectAccess middleware routers"` | 628 | ❌ | `rg -l` | 1 | 198 | ✅ |
| | **Total** | | **7,427** | **2 / 10** | | **15** | **1,833** | **10 / 10** |

**graphify cost 4.05× more tokens and got a fifth of the answers right. It did not win a
single question — not one — on either axis.**

### What went wrong, question by question

- **`query` returns a keyword neighbourhood, not an answer.** Q2 asked where requirement
  blocks are split and got 35 nodes of Slack `block-kit.ts` — it matched the word "block".
  Q8 asked for `table-relevance-filter.ts` and returned 69 nodes of generic hubs
  (`prisma.ts`, `logger.ts`, `error-handler.ts`) **without the target file appearing at
  all**. Q10 asked which routers use `requireProjectAccess` and returned Next.js UI
  middleware and test helpers — zero routers. Each of those cost ~1,525 tokens, because
  `query` spends its whole budget whether or not it has the answer; `rg -l` cost 78–198
  and was exact.
- **`explain` cannot express direction, so it cannot answer "what calls X".** Q4, Q7 and
  Q9 all asked for callers. `explain` prints every neighbour with a `-->` arrow regardless
  of which way the edge points, so an inbound `contains` edge and an outbound `calls` edge
  render identically. Worse, the actual callers were simply absent: `explain
  "applySupportPanel"` never mentions `orchestrator.ts`, which calls it at lines 2358 and
  2736; `explain "approveDraft"` never mentions `routes/publishing.ts:151`.
- **`path` reported a route that does not exist** (Q5) — see below.
- **The two it got right, it got right expensively.** Q1's import list was correct but
  truncated at 20 of 26 connections and cost 2× the grep. Q6 was correct at 4.4× the cost.

### The `path` defect, proven

```
$ graphify path server/src/lib/analysis/clarification-enrichment.ts \
                server/src/lib/publishing/draft-generator.ts
Shortest path (2 hops):
  clarification-enrichment.ts --imports_from--> logger.ts --imports_from--> draft-generator.ts
```

The middle hop is fabricated. Read straight from `graph.json`'s own `_src`/`_tgt` fields,
both stored edges point **into** `logger.ts`:

```
clarification-enrichment.ts --imports_from--> logger.ts   (EXTRACTED, L35)
draft-generator.ts          --imports_from--> logger.ts   (EXTRACTED, L28)
```

`logger.ts` has three outbound edges in the entire 22,543-edge graph, all `contains` to its
own functions, and zero outbound `imports_from` — it imports only `winston`. Computing the
transitive directed closure from the same data: 93 modules are reachable from
`clarification-enrichment.ts`, and `draft-generator.ts` is not among them, in either
direction. **The correct answer is "no path"; graphify confidently answers "2 hops".**

Root cause, in upstream source: `build_from_json(extraction, *, directed: bool = False)` —
undirected by default "for backward compatibility" — and `path` then runs
`nx.shortest_path` over that undirected graph while rendering every hop as `--rel-->`. In
a codebase where nearly every file imports the logger, the ORM client and the config
module, undirected connectivity is close to universal and therefore carries almost no
information.

This is **not our bug** — we consume the PyPI package, we do not vendor it. It survives on
the latest 0.9.30 (where it additionally resolved the target past the requested file into
`publishing-draft-generator.test.ts`). Filed upstream as
[Graphify-Labs/graphify#2309](https://github.com/Graphify-Labs/graphify/issues/2309),
a regression of their closed #849 and related to #829 and #2074.

### Where the "165×" number came from

`CLAUDE.md` advertised "~165× fewer tokens per structural query". That figure is
`graphify benchmark`'s, and its baseline is **reading the entire 409k-token corpus**. No
agent has ever answered "what calls X" by reading the whole repo. Against the alternative
agents actually use — one scoped `Grep` — graphify is 4× *more* expensive. The number was
never wrong; it was measured against a baseline nobody uses.

## Honesty corrections to #1143's own framing

Two of the epic's numbers do not survive a recount of `.github/hooks/logs/terminal.log`,
and are corrected here so the record is accurate:

- **`graphify path` and `explain` were not "never run".** Recounting the 26,942 logged
  command records finds `path` invoked on 2026-07-22 (×3) and 2026-07-26 (×2), and
  `explain` on 07-17 and 07-22 (×3) — before the epic's own reproduction runs. The claim
  should be "rarely run" (≈10 times in six weeks), not "never".
- Recounted totals: `graphify query` **79**, `update` **138**, and **8,320** commands where
  a search tool leads a segment. The epic quotes 62 / 52 / 11,089 against 91,847 "commands"
  (that is the log's *line* count; multi-line commands span lines). The ratio the epic
  argues from — roughly 100:1 against graphify — holds under either count.

The correction matters because it removes the strongest rhetorical point ("the flagship
commands have never been run") while leaving the decision unchanged. The decision rests on
the counterfactual, not on the usage log — low usage cannot distinguish "not useful" from
"instruction buried in a 3.2k-token file", which is exactly why the counterfactual was run.

## Decision

**Keep graphify, unadvertised.** Specifically:

1. **Remove the agent-facing navigation instruction from `CLAUDE.md`**, reclaiming ~900
   tokens on every subagent delegation. Agents use `Grep`/`Glob`/`Explore`.
2. **Keep `graphify-out/` tracked**, for `GRAPH_REPORT.md` as a human codebase overview and
   for the existing CI refresh. The retained rule that branches must never commit a
   regenerated `graph.json` (#916) stays — it prevents a real, recurring failure.
3. **De-recommend `graphify path` explicitly** until upstream #2309 lands.
4. **Delete the `graphify-hint.mjs` PreToolUse hook.**

### Why not "keep and fix"

Narrowing the recommendation to the question classes where graphify wins requires there to
be such a class. There is not one in the measurement: it lost all ten, on tokens, and eight
of ten on correctness. The underlying *data* is sound — the correct reachability answer was
recoverable from `graph.json`'s `_src`/`_tgt` fields in a dozen lines of Python — but the
three commands built on that data are the product, and we do not own them.

### Why not "retire"

Deleting `graphify-out/` would end the #916 rebase treadmill, but it is a 10.7 MB
tracked-history change with its own CI workflow, `.graphifyignore`, local runner scripts and
docs attached. That is a separate, larger decision and should not ride along with a
documentation change. Filed as a follow-up, deliberately not done here.

## Consequences

- ~900 tokens per subagent delegation reclaimed; on a 13-subagent session, ~12k tokens.
- No agent-facing advice now points at a command that returns false dependency routes.
- The #916 treadmill is **not** fixed by this decision — `graphify-out/` is still tracked
  and still rewritten by main's CI on every merge.
- The hook's removal ends a per-search context injection that, in the session that produced
  this decision, fired eight times and was a false positive every time — on `find` inside a
  Python site-packages tree, on `rg --version`, and on greps of scratch files outside the
  repo.
- One measured hazard is now documented rather than assumed: because `graph.json` is 10.7 MB
  on a single line, an unscoped `rg -n "<symbol>"` at the repo root pulls it in as one match
  line. Q4, Q7 and Q9 each cost ~2.77M tokens that way before being scoped to
  `server/src ui packages`. The tracked graph taxes the native path too.
