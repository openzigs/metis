/**
 * Types for `busy-transformers.mjs`, the plain-JS `@huggingface/transformers`
 * stand-in (it stays JavaScript because the embed worker loads it by URL).
 * Declares exactly the fixture's exports; keep the two files in step.
 */

/** Default per-text block, in milliseconds. */
export declare const BUSY_MS_PER_TEXT: number;
/** How long one `__long__` text blocks its single call, in milliseconds. */
export declare const LONG_ROW_MS: number;

/** Mutable settings object, as transformers.js exposes it (`allowRemoteModels`, ...). */
export declare const env: Record<string, unknown>;

export interface BusyTokenizer {
  readonly model_max_length: number;
}

export interface BusyPipeline {
  (
    texts: string | string[],
    runOpts: { pooling: string; normalize?: boolean },
  ): Promise<{ data: Float32Array; dims: [number, number] }>;
  tokenizer: BusyTokenizer;
  model: { config: { model_type: string; dtype: unknown } };
}

export declare function pipeline(
  task: string,
  model: string,
  opts?: { dtype?: unknown },
): Promise<BusyPipeline>;
