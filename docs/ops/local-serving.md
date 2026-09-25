# Local serving runbook — PC vLLM (TP=2) + Mac Ollama, OpenAI-compatible `/v1`

> **Issue [#332](https://github.com/openzigs/metis-private/issues/332)** (Epic #331, Phase 1 — Serving).
> Stand up **OpenAI-compatible local serving** on both machines so METIS's
> `local-gemma` provider can target them. This runbook is the operator's
> step-by-step: exact start commands, the fallback ladder, env wiring, and how to
> verify with the smoke test. **Bringing the live GPU servers up is a hands-on
> step you (the operator) run on your own hardware** — this doc tells you exactly
> how.

## What METIS needs from a local endpoint

METIS plugs local models in through the generic OpenAI-compatible **`local-gemma`**
provider — no new provider code is required to serve. The contract is just three
env vars (see [`.env.example`](../../.env.example)):

| Var | Meaning | Hard rule |
|---|---|---|
| `LOCAL_GEMMA_BASE_URL` | OpenAI-compatible base | **MUST end in `/v1`**, MUST be loopback or RFC-1918/private |
| `LOCAL_GEMMA_MODEL` | model id the server serves | per machine (see below) |
| `LOCAL_GEMMA_API_KEY` | bearer token | dummy `ollama` for Ollama; a real token if vLLM enforces one |

The base URL is enforced by `validateLocalProviderUrl`
(`server/src/lib/ai/config.ts`): it accepts **loopback** (`http://localhost:11434/v1`,
`http://127.0.0.1:8000/v1`) and **RFC-1918 / private** hosts
(`http://192.168.x.x/v1`, `10.x`, `172.16–31.x`) and **rejects every public host**
— including `api.openai.com`, `*.azure.com`, `*.anthropic.com` — so document
content can never egress. For the **cross-machine** case use the serving box's
**private LAN IP** (still RFC-1918) or an **SSH tunnel to loopback** (below).
Internal DNS **service names** like `http://ollama:11434/v1` are intentionally
rejected — use a loopback or IP literal.

---

## Hardware in this deployment (measured)

| Box | Hardware | Path |
|---|---|---|
| **Mac** | Apple **M4 Pro, 24 GB** unified RAM | **Ollama (Metal)** — NOT MLX |
| **PC** | **2× RTX 3060 12 GB, no NVLink** (24 GB total) | **vLLM `--tensor-parallel-size 2`** |

### Why the Mac is Ollama, not MLX

MLX only activates at **≥ 32 GB** unified RAM, and a model should fit in roughly
60–70% of RAM. **24 GB is below the MLX threshold**, so the Mac path is **Ollama
on Metal** running a **14B-class Q4** model (≤ ~16 GB weights). Ollama is already
installed and its OpenAI-compatible `/v1` endpoint is **validated working** on this
Mac (`qwen2.5:3b` returns a clean completion at `http://localhost:11434/v1`).

---

## ⚠️ Model choice — avoid reasoning models for doc-gen

**Do NOT use the current METIS default `gemma4:12b` for local doc-generation.**
`gemma4:12b` is a **reasoning model**. Served over `/v1` it spends the token
budget inside a `reasoning` field and returns an **EMPTY** `content` at low
`max_tokens` (`finish_reason: "length"`); visible content only appears at high
`max_tokens`. Reasoning models also hallucinate more on faithful extraction,
which is exactly what METIS's grounding/faithfulness pipeline penalizes.

> **The empty-content trap.** A naive smoke test that only checks HTTP 200 will
> call this a pass while doc-gen silently produces empty sections. The smoke-test
> tool in this repo (`scripts/local-llm/smoke-test.mjs`) detects it: it fails with
> `reasoning-empty-content` when `content` is empty while a
> `reasoning`/`reasoning_content` field is present **or** `finish_reason === "length"`.

**Recommended for the Mac (clean instruct model):**

- **Qwen2.5-14B-Instruct** — Ollama tag `qwen2.5:14b` (≈ 9 GB Q4, fits 24 GB comfortably). **First choice.**
- **Qwen3-14B with thinking disabled** — if you prefer the Qwen3 generation, you
  MUST turn thinking off (Qwen3 is a hybrid reasoning model; left on it hits the
  same empty-content trap). Disable per request with `/no_think` in the prompt or
  by setting the model's thinking option off.

Pull it (the live `ollama pull` is your hands-on step):

```bash
ollama pull qwen2.5:14b
```

---

## Mac — Ollama (Metal)

**1. Ensure Ollama is serving.** Ollama is already installed; its OpenAI-compatible
endpoint is `http://localhost:11434/v1`.

```bash
# foreground (ad-hoc); or run as a login service — see the USER_GUIDE Windows
# section for the service-wrapper options. On macOS the Ollama.app menubar agent
# keeps it running across logins.
ollama serve
```

Verify the server is up (lists installed models):

```bash
curl http://localhost:11434/v1/models
```

**2. Point METIS at it.** In `.env` on the Mac:

```dotenv
AI_PROVIDER=local-gemma
LOCAL_GEMMA_BASE_URL=http://localhost:11434/v1   # /v1 suffix is required
LOCAL_GEMMA_MODEL=qwen2.5:14b                     # clean instruct model — NOT gemma4:12b
LOCAL_GEMMA_API_KEY=ollama                        # dummy bearer; header required, value ignored
```

**3. Smoke-test it** (see [Verify](#verify-the-endpoint-smoke-test) below).

---

## PC — vLLM, tensor-parallel across 2× RTX 3060

Run inside **WSL2 Ubuntu**. The primary config is **TP=2** across both 3060s.
**Installing vLLM and starting the server are your hands-on steps.**

Qwen3-32B AWQ Q4 ≈ 19.7 GB weights → fits 24 GB **only** via TP=2, leaving ~4 GB
for KV cache + activations. **Llama-3.3-70B (~43 GB) does NOT fit — excluded.**

### Primary: TP=2

```bash
vllm serve Qwen/Qwen3-32B-AWQ \
  --tensor-parallel-size 2 \
  --gpu-memory-utilization 0.92 \
  --max-model-len <measured>
```

- `<measured>` — **you must measure** the maximum stable `--max-model-len` that
  does not OOM on this box, and the achievable tokens/sec. Start low (e.g. 8192),
  raise until you OOM, then back off. Record both numbers in the table at the
  bottom of this file.
- The default vLLM bearer is unenforced unless you pass `--api-key`; if you set
  one, mirror it into `LOCAL_GEMMA_API_KEY` on the METIS side.

> **⚠️ PCIe-only TP hang risk.** These 3060s have **no NVLink**, so tensor-parallel
> traffic crosses PCIe. vLLM has a **documented hang / 100%-util failure** for
> PCIe-only multi-GPU TP — [vLLM #14449](https://github.com/vllm-project/vllm/issues/14449).
> If `vllm serve` hangs at startup or pins both GPUs at 100% util with no
> throughput, **do not wait it out** — drop to the fallback ladder. Setting
> `NCCL_P2P_DISABLE=1` before launch sometimes works around the P2P hang at a
> throughput cost; if it doesn't, fall back.

### Fallback ladder (from #332)

Take the first rung that comes up stable:

1. **Fallback A — pipeline parallel instead of tensor parallel.** Splits by layer
   across the two cards over PCIe; avoids the all-reduce pattern that triggers the
   TP hang.

   ```bash
   vllm serve Qwen/Qwen3-32B-AWQ \
     --pipeline-parallel-size 2 \
     --gpu-memory-utilization 0.92 \
     --max-model-len <measured>
   ```

2. **Fallback B — single-card 14B.** If multi-GPU is unstable, serve a 14B AWQ
   model on **one** card (no cross-GPU traffic at all). This is the most robust
   option on a PCIe-only box.

   ```bash
   vllm serve Qwen/Qwen3-14B-AWQ \
     --gpu-memory-utilization 0.92 \
     --max-model-len <measured>
   # pin to one card if needed:  CUDA_VISIBLE_DEVICES=0 vllm serve ...
   ```

Whichever rung you land on, **record the exact command line + measured
`--max-model-len` + tokens/sec** in the results table below.

### Point METIS at the PC

vLLM's default port is **8000**. On the PC itself:

```dotenv
AI_PROVIDER=local-gemma
LOCAL_GEMMA_BASE_URL=http://localhost:8000/v1
LOCAL_GEMMA_MODEL=Qwen/Qwen3-32B-AWQ        # or the fallback model you served
LOCAL_GEMMA_API_KEY=ollama                  # or the real --api-key you set on vLLM
```

---

## Cross-machine wiring (METIS on one box, model on another)

The URL guard rejects public hosts, so use **one** of these:

- **Private LAN IP (RFC-1918) — simplest.** Bind vLLM to all interfaces
  (`--host 0.0.0.0`) and point METIS at the serving box's LAN IP:

  ```dotenv
  LOCAL_GEMMA_BASE_URL=http://192.168.1.50:8000/v1   # PC vLLM, reached over the LAN
  ```

- **SSH tunnel to loopback — most locked-down.** Forward the remote port to a
  local one and keep the URL on `localhost` (passes the guard, no LAN exposure):

  ```bash
  # on the METIS box: forward local 8000 -> PC's 8000
  ssh -N -L 8000:localhost:8000 user@192.168.1.50
  ```
  ```dotenv
  LOCAL_GEMMA_BASE_URL=http://localhost:8000/v1
  ```

---

## Verify the endpoint (smoke test)

A repo tool POSTs a tiny chat request to `<base>/chat/completions` and asserts a
**non-empty** `choices[0].message.content`. It also fails loudly on the
**reasoning-model empty-content trap** (empty content + reasoning tokens, or
`finish_reason: "length"`).

```bash
# reads LOCAL_GEMMA_BASE_URL / LOCAL_GEMMA_MODEL / LOCAL_GEMMA_API_KEY from env
node scripts/local-llm/smoke-test.mjs

# or pass explicitly (Mac / Ollama):
node scripts/local-llm/smoke-test.mjs --base http://localhost:11434/v1 --model qwen2.5:14b

# PC / vLLM over the LAN, with a bigger budget:
node scripts/local-llm/smoke-test.mjs --base http://192.168.1.50:8000/v1 \
  --model Qwen/Qwen3-32B-AWQ --max-tokens 256
```

Exit code `0` = a non-empty completion came back. A non-zero exit prints the
failure category, e.g.:

- `FAIL [reasoning-empty-content]` — the endpoint is **reachable** but the model
  returned no usable text (reasoning tokens or length-truncated). Switch to a
  clean instruct model (`qwen2.5:14b`) and/or raise `--max-tokens`.
- `FAIL: could not reach …` — the server isn't up / the URL is wrong.

A green smoke test plus METIS's own `/readyz` (which probes `provider.ping()`
against `LOCAL_GEMMA_BASE_URL`) reporting AI `ok` confirms the full path.

---

## Results — fill in after you bring servers up

Record the chosen config and measured limits here (this satisfies the #332 ACs):

| Box | Model served | Command / parallelism | `--max-model-len` (max stable) | Tokens/sec | Notes (TP hang? fallback taken?) |
|---|---|---|---|---|---|
| Mac | `qwen2.5:14b` | Ollama (Metal) | n/a (Ollama-managed) | _measure_ | |
| PC | _Qwen3-32B-AWQ / fallback_ | _TP=2 / PP=2 / single-card 14B_ | _measure_ | _measure_ | |

---

## Right-sizing the doc-gen tuning knobs (Issue #337)

> **Issue [#337](https://github.com/openzigs/metis-private/issues/337)** (Epic #331, Phase 2 — Tuning).
> The local doc-gen tuning knobs **already exist** and are env-configurable via
> `docsGenTuning('local', …)` (`server/src/lib/docs-gen/holistic-synthesizer.ts`).
> This section is the operator runbook: **how to set each knob to the served
> model's real context window**, per-model recommended values, and the guardrail
> that now makes over-cap runs observable instead of silent.

### The knobs (all `local`-namespaced, independently overridable)

| Env var | Default | What it controls | Consumed at |
|---|---|---|---|
| `DOCS_GEN_LOCAL_FACTS_CHAR_CAP` | `48000` | Per-section chars of module facts sent to the model. Floor `4000`; below-floor/invalid → default. | `docsGenTuning.factsCharCap` → `buildRelevantFactsBlob` |
| `DOCS_GEN_LOCAL_TEMPERATURE` | per model family: `1.0` Gemma, `0.2` other/unknown | Sampling temperature for local docs-gen calls. Always sent explicitly. | `tuning.temperature` |
| `DOCS_GEN_LOCAL_TOP_P` | `0.95` | Nucleus sampling top_p. Always sent explicitly. | `tuning.topP` |
| `DOCS_GEN_LOCAL_ENABLE_THINKING` | unset (thinking **off**) | Set truthy to allow the model's internal reasoning block. | `tuning.disableThinking = !flag` |
| `DOCS_GEN_LOCAL_PHASE1_MODEL` | `gemma3:4b` | Fast structured fact-extraction model. | `tuning.phase1Model` |
| `DOCS_GEN_LOCAL_PHASE2_MODEL` | `LOCAL_GEMMA_MODEL ?? gemma3:12b` | Synthesis model (never the `gemma4:12b` reasoning default). | `tuning.phase2Model` |
| `DOCS_GEN_LOCAL_REFINE` | unset (off) | Extra low-temp refine pass per section (slower, better). | `tuning.refine` |
| `DOCS_GEN_LOCAL_CONCISE_PROMPT` | unset (off) | Short prompt variant (terser output). Leave off for detailed docs. | `tuning.concisePrompt` |
| `DOCS_GEN_LOCAL_STRUCTURED_OUTPUT` | unset (off) | `json_schema` (or `1`): #336 schema-constrained JSON on the grounding calls (vLLM/xgrammar); an unparseable reply is retried once in JSON mode. `json_object` (#117): JSON mode with the shape in the prompt, for a runtime that accepts `json_schema` and ignores it (`laguna-s-2.1` on Ollama). `off` (or `0`). | grounding calls only |

### Provider timeouts — size the first-token budget to prefill (Issue #111)

A local runtime streams **nothing** until it has processed the whole prompt, so
its time to first token is `prompt_tokens / prefill_tok_per_s`, and raising
`DOCS_GEN_LOCAL_FACTS_CHAR_CAP` raises it with it. Measured on 2026-09-23: a
130,482-token section prompt at ~224 tok/s needed ~9.7 min, and the 10-min
default aborted it with 98% of the prompt processed. These apply to every
`local-gemma` provider (chat, analysis, docs-gen single and hybrid), in ms, with
`0` disabling the guard. Write plain digits (`1200000`, not `1_200_000` or
`1.2e6`), at most `2147453647` (~24.8 days; a longer Node timer fires after 1 ms);
any other value keeps the default and logs `Ignoring invalid local timeout`:

| Env var | Default | Governs |
|---|---|---|
| `LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS` | `600000` | Streaming time to first token (prefill). |
| `LOCAL_GEMMA_IDLE_TIMEOUT_MS` | `120000` | Gap between tokens once streaming has started. |
| `LOCAL_GEMMA_REQUEST_TIMEOUT_MS` | `300000` | A whole non-streaming request. |

A first-token timeout logs `Stream timed out before the first token` with the
prompt size in characters and the budget, and names the knob in the error. It is
**not retried**: re-sending the same prompt repeats the whole prefill (Ollama
logs `forcing full prompt re-processing`) and times out the same way.

#### Concurrency and thinking control

Ollama serves **one request per model at a time** unless `OLLAMA_NUM_PARALLEL`
is raised, queues the rest FIFO, and sends no bytes — not even headers — for a
queued request. METIS therefore queues its own `local-gemma` requests in a
process-wide FIFO limiter per base URL, and starts the timeouts above only once a
request holds a slot, so waiting behind another generation is never reported as a
first-token stall.

| Env var | Default | Governs |
|---|---|---|
| `LOCAL_GEMMA_MAX_CONCURRENCY` | `1` | Max in-flight requests per `LOCAL_GEMMA_BASE_URL`, across docs-gen, grounding, analysis and chat. Set it to the server's `OLLAMA_NUM_PARALLEL`. Positive integer; anything else keeps `1` and warns. |
| `LOCAL_GEMMA_SEND_REASONING_EFFORT` | `auto` | Whether `reasoning_effort` is sent. `auto`: send; if the model rejects it, retry once without and remember the model. `always`: send, never fall back. `never`: never send. |

With thinking off (the docs-gen default; `DOCS_GEN_LOCAL_ENABLE_THINKING`
re-enables it), requests carry `think: false` **and** `reasoning_effort: "none"`.
The second field is the one that works on Ollama's `/v1` endpoint: measured on
Ollama 0.34.2, laguna-s-2.1 with `think: false` alone spent 800/800 output tokens
reasoning and was cut off (`finish_reason: length`); with `reasoning_effort:
"none"` it answered in 180 tokens with no reasoning. gemma3:12b (no thinking
support) accepts `"none"` and returns `400 "gemma3:12b" does not support thinking`
for any other effort, which the `auto` fallback absorbs. An explicit effort
(`DOCS_GEN_PHASE1_REASONING=low|medium|high`) is sent as `reasoning_effort`.

### Sizing `DOCS_GEN_LOCAL_FACTS_CHAR_CAP` — the derivation

The cap is a **per-section character budget** for the facts blob. It must leave
room for the system prompt and the output so the whole request stays inside the
served model's **effective** context window. Overflow is the failure mode the
epic warns about: the runtime **context-shifts**, silently drops the system
instructions, and returns an **empty or fabricated section**.

```
facts_budget_chars ≈ (effective_context_tokens − system_prompt_tokens − output_budget_tokens) × chars_per_token
```

Working numbers for METIS doc-gen:

- **chars/token ≈ 3.3** for English + code (conservative; METIS's default
  `48000 chars ≈ 14K tokens` uses this ratio).
- **system prompt** ≈ 1.5–2K tokens (the verbose per-section instructions).
- **output budget** ≈ 2–4K tokens per section (detailed sections are large).

So for a served model with an **effective** window `W` tokens (the measured
`--max-model-len` for vLLM, or `OLLAMA_CONTEXT_LENGTH` for Ollama — **not** the
model's advertised max, which local KV-cache limits often force below):

```
cap_chars ≈ (W − 2000 − 4000) × 3.3
```

Reserve headroom — target ~**80% of the theoretical budget** so a long section
does not tip over. Always raise the cap **in lock-step** with the served window,
never past it.

| Effective window (tokens) | Budget after prompt+output | Theoretical cap (chars) | **Recommended cap (80%)** |
|---|---|---|---|
| 8,192 (tight vLLM TP=2 / 3060) | ~2,200 tok | ~7,300 | **`6000`** |
| 16,384 | ~10,400 tok | ~34,000 | **`27000`** |
| 32,768 (Ollama default ctx) | ~26,800 tok | ~88,000 | **`48000`** (the shipped default) |
| 65,536 | ~59,500 tok | ~196,000 | **`96000`** (bump only if the model holds quality past ~60% fill) |

> **Ollama caveat:** Ollama defaults to a **2,048-token** context unless you set
> `OLLAMA_CONTEXT_LENGTH` (or `num_ctx` per request). If you leave it at 2,048 the
> effective window is tiny — the `48000` cap will massively overflow it. **Set
> `OLLAMA_CONTEXT_LENGTH=32768` (or your model's real ctx) and size the cap to
> match.**

### Temperature — per served model, NOT a blind 0

**Shipped defaults (#177).** When `DOCS_GEN_LOCAL_TEMPERATURE` / `DOCS_GEN_LOCAL_TOP_P`
are unset, METIS picks them from the family of the Phase-2 model
(`DOCS_GEN_LOCAL_PHASE2_MODEL`, else `LOCAL_GEMMA_MODEL`):

| Model name contains | temperature | top_p | Why |
|---|---|---|---|
| `gemma` | `1.0` | `0.95` | Google's Gemma model card; lower temperatures return empty content on Gemma 4 |
| anything else, or unknown | `0.2` | `0.95` | Conservative extraction setting: an independent evaluation measured 0.2 as the best Phase-1 extraction on laguna-s-2.1, where 1.0 was in use |

Both values are **always sent** on every local docs-gen request. Ollama's `/v1`
endpoint substitutes `temperature=1.0` and `top_p=1.0` for a field that is
omitted, so leaving one out would silently change the sampling. One tuning
serves both phases, so if your Phase-1 model is a different family from your
Phase-2 model (e.g. `gemma3:4b` extraction with a non-Gemma Phase 2), set
`DOCS_GEN_LOCAL_TEMPERATURE` explicitly. An explicit env value always wins.

- **Gemma 3 / Gemma 4 (MoE):** keep `DOCS_GEN_LOCAL_TEMPERATURE=1.0`,
  `TOP_P=0.95` (Google's model-card mandate). Lower temperatures make Gemma's MoE
  routing over-activate thinking and return **empty content** — this is why the
  shipped Gemma default is `1.0`, not `0`. Also keep thinking **disabled** (default).
- **Dense instruct models (Qwen2.5, Qwen3-with-thinking-off, Phi-4):** these do
  literal/reconstruction work faithfully at **near-deterministic** settings. Set
  `DOCS_GEN_LOCAL_TEMPERATURE=0` (or `0.1`) for the most reproducible, faithful
  extraction; leave `TOP_P` at the default. Validate empirically with the eval
  harness (#335) before trusting a project — a section that comes back empty at
  low temp means the model is a hybrid-reasoning model that needs thinking
  explicitly off (Qwen3 `/no_think`) rather than a temperature problem.

### Recommended env per served model

**Mac — Ollama, `qwen2.5:14b` (this deployment, dense instruct):**

```dotenv
OLLAMA_CONTEXT_LENGTH=32768                 # raise Ollama's tiny 2048 default!
DOCS_GEN_LOCAL_FACTS_CHAR_CAP=48000         # fits the 32K window (~14K tok)
DOCS_GEN_LOCAL_TEMPERATURE=0                # dense model → near-deterministic, faithful
# TOP_P left at default 0.95; thinking left OFF (default); PHASE2 = qwen2.5:14b via LOCAL_GEMMA_MODEL
```

**PC — vLLM TP=2, `Qwen/Qwen3-32B-AWQ` (tight KV cache):**

```dotenv
# --max-model-len you MEASURED on the box (start 8192, raise until OOM, back off)
DOCS_GEN_LOCAL_FACTS_CHAR_CAP=6000          # sized to a tight ~8K effective window
DOCS_GEN_LOCAL_TEMPERATURE=0                # dense model
DOCS_GEN_LOCAL_ENABLE_THINKING=             # unset → thinking OFF (Qwen3 is hybrid-reasoning)
# raise the cap in lock-step if you push --max-model-len higher (see the table)
```

**PC — vLLM single-card 14B fallback, `Qwen/Qwen3-14B-AWQ`:**

```dotenv
DOCS_GEN_LOCAL_FACTS_CHAR_CAP=27000         # a ~16K window fits more facts than TP=2's tight KV
DOCS_GEN_LOCAL_TEMPERATURE=0
```

**If you must run a Gemma model:**

```dotenv
DOCS_GEN_LOCAL_TEMPERATURE=1.0              # Gemma mandate — do NOT lower
DOCS_GEN_LOCAL_TOP_P=0.95
# thinking OFF (default); size the cap to the served window as above
```

### The truncation guardrail (#337) — over-cap runs are now observable

Previously, when a section's relevance-ranked facts exceeded `factsCharCap`,
`buildRelevantFactsBlob` **silently** dropped the lowest-ranked modules (it only
appended a compact "ADDITIONAL MODULES" catalog). On a tight local window that
silent drop is exactly what triggers the empty-section failure — with no signal.

Now, whenever a section's facts exceed the cap:

1. **Always** — a `log.warn("Section facts exceeded the facts char cap — modules
   omitted", …)` telemetry line is emitted (`projectId`, `section`, `provider`,
   `factsCharCap`, `includedModules`, `omittedModules`, `includedChars`).
2. **On every provider** — a `facts-truncated` **DocWarning** is raised, so
   `deriveDocStatus` marks the document **`degraded`** and the UI banner tells the
   operator the concrete remedy: **raise `DOCS_GEN_LOCAL_FACTS_CHAR_CAP`** (in
   lock-step with the served window) **or narrow retrieval**.

Until #175 the warning was local-only and Bedrock/Anthropic were log-only, so a
cloud document could leave modules out with nothing on the document to say so.
Cloud warnings now name their own knob (`DOCS_GEN_BEDROCK_FACTS_CHAR_CAP` /
`DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP`, default 150,000); which modules are selected
is unchanged.

**Operator action when you see a `facts-truncated` warning:** the local run
dropped relevant facts. Either raise `OLLAMA_CONTEXT_LENGTH` / vLLM
`--max-model-len` and the matching `DOCS_GEN_LOCAL_FACTS_CHAR_CAP` per the table
above, or accept the smaller scope. Do **not** raise the cap past the served
window — that reintroduces silent context-shift.

---

## Eval-gated rollout — the A/B gate (#335)

The local-first defaults (`DOCS_GEN_HYBRID_ROUTING`, `DOCS_GEN_JUDGE_ESCALATION`)
ship **default-OFF**. The convention for flipping either default ON is
**eval-gated**: a PR that changes a default MUST link a green run of the A/B
rollout gate. No default flip without evidence.

### What it measures

`pnpm eval:domain:ab` (→ `server/scripts/eval-hybrid-ab.ts`) runs the **same
fixture corpus** through two configurations and compares them:

| Arm | Config | Routing |
|-----|--------|---------|
| **A — all-Sonnet** (baseline) | hybrid routing OFF | every section on the cloud provider (current production behaviour) |
| **B — local+escalation** (candidate) | `DOCS_GEN_HYBRID_ROUTING=1` + `DOCS_GEN_JUDGE_ESCALATION=1` | literal/reconstruction → local, narrative → cloud; below-threshold local sections re-run on the cloud provider (#334) |

For each arm it reports, reusing the existing `FaithfulnessJudge` scoring:

- **faithfulness** — overall + per-tier (narrative / reconstruction / literal) means;
- **escalation rate** — fraction of sections that escalated to the cloud (#334);
- **cost proxy** — token counts, with local tokens treated as free and cloud tokens billed.

### The pass/fail criterion (Arm B passes iff ALL hold)

| # | Criterion | Default threshold | Rationale |
|---|-----------|-------------------|-----------|
| 1 | Overall faithfulness within epsilon of baseline (`meanB ≥ meanA − ε`) | `overallEpsilon = 0.05` | The epic's "within an acceptable delta" — a ≤5% overall drop is tolerable given the cost win. |
| 2 | Every tier within epsilon of baseline | `tierEpsilon = 0.05` | An overall pass can hide one tier collapsing; gate each tier too. |
| 3 | No candidate tier below its own gate floor | narrative 0.4 / reconstruction 0.6 / literal 0.8 | "No section type regressing below its tier threshold" — reuses the SAME constants the synthesizer gates at, so the A/B floor can never drift from production. |
| 4 | Candidate escalation rate ≤ bound | `maxEscalationRate = 0.5` | A high escalation rate means local rarely clears the bar unaided — the hybrid win is illusory. |
| 5 | Cost reduction ≥ target (`1 − costB/costA`) | `minCostReduction = 0.6` | The epic's ≥60% cost-reduction example. Skipped when baseline cost is 0. |

Insufficient data (no verified sections for a tier) is treated as a PASS — the
gate never fails on missing evidence, only on measured regression. All thresholds
are configurable via the `runAbEval({ thresholds })` seam.

### Running it

```bash
pnpm eval:domain:ab            # run live (requires local + cloud providers configured)
pnpm eval:domain:ab --json     # also print the JSON summary to stdout
pnpm eval:domain:ab --no-fail  # always exit 0 (exploration; don't gate)
```

The command prints a human comparison table + verdict and writes a
machine-readable JSON summary to `eval-results/hybrid-ab-<runId>.json` (attach it
to the rollout PR). **Exit code is non-zero when the gate FAILS**, so it can gate
a rollout in CI or a manual run.

> This is an **operator tool run against real providers**. It is NOT run in CI —
> there are no live local/cloud models in CI. CI instead exercises the
> comparison/aggregation/gating LOGIC with a mocked provider seam
> (`server/src/lib/eval/hybrid-ab/*.test.ts`). To run it live, configure the
> local provider (`LOCAL_GEMMA_*`) and the cloud provider exactly as a real
> docs-gen run requires.

### Rollout policy

1. Run `pnpm eval:domain:ab` against a representative corpus with local + cloud both configured.
2. If it **PASSES**, open a PR flipping the default(s) ON and **attach the JSON summary + table** as evidence.
3. If it **FAILS**, iterate on the local model choice / tuning knobs (see the
   sizing section above) or the escalation budget — do NOT flip the default.

---

## See also

- [`docs/USER_GUIDE.md` §5.4](../USER_GUIDE.md#54-ai-configuration) — pointing METIS at a local endpoint via `local-gemma`.
- [`.env.example`](../../.env.example) — the per-machine `LOCAL_GEMMA_*` blocks.
- `server/src/lib/ai/config.ts` — `validateLocalProviderUrl` (the loopback/RFC-1918 guard).
- `scripts/local-llm/smoke-test.mjs` — the chat-completions smoke test + reasoning-trap detector.
