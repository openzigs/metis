/**
 * Issue #189 — a stand-in for `@huggingface/transformers` whose pipeline BLOCKS
 * its thread for `BUSY_MS_PER_TEXT` per text, exactly as `onnxruntime-node`'s
 * synchronous `InferenceSession.run` blocks the thread that calls it.
 *
 * Plain JavaScript on purpose: the embed worker imports it by URL and cannot load
 * TypeScript. Each vector encodes what the worker applied, so tests can read it:
 *   [text.length, tokenizer.model_max_length, env.allowRemoteModels === false ? 1 : 0,
 *    rows in this model call]
 * `model` names containing "fail-load" reject at load; a `@<n>ms` suffix sets the
 * per-text block (default BUSY_MS_PER_TEXT); the text "__explode__" rejects at run,
 * and "__crash__" exits the thread it runs on.
 */
export const BUSY_MS_PER_TEXT = 40;
/**
 * A text containing `__long__` blocks this long in ONE call — the shape of the real
 * hang: a single over-long row run at full context is one multi-second native call.
 */
export const LONG_ROW_MS = 1500;

export const env = {};

function blockThread(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Spin: indistinguishable, to the event loop, from a synchronous native call.
  }
}

export async function pipeline(task, model, opts) {
  if (task !== "feature-extraction") throw new Error(`unexpected task ${task}`);
  if (model.includes("fail-load")) throw new Error(`cannot load ${model}`);
  const tokenizer = { model_max_length: 8192 };
  const perText = Number(/@(\d+)ms$/.exec(model)?.[1] ?? BUSY_MS_PER_TEXT);
  const run = async (texts, runOpts) => {
    const rows = Array.isArray(texts) ? texts : [texts];
    if (rows.includes("__explode__")) throw new Error("busy pipeline exploded");
    // Ends the embed worker's thread outright — a native crash, as far as the host can tell.
    if (rows.includes("__crash__")) process.exit(3);
    if (!runOpts || typeof runOpts.pooling !== "string") throw new Error("pooling missing");
    const data = new Float32Array(rows.length * 4);
    rows.forEach((text, i) => {
      blockThread(text.includes("__long__") ? LONG_ROW_MS : perText);
      data[i * 4] = text.length;
      data[i * 4 + 1] = tokenizer.model_max_length;
      data[i * 4 + 2] = env.allowRemoteModels === false ? 1 : 0;
      data[i * 4 + 3] = rows.length;
    });
    return { data, dims: [rows.length, 4] };
  };
  run.tokenizer = tokenizer;
  run.model = { config: { model_type: "busy", dtype: opts?.dtype ?? null } };
  return run;
}
