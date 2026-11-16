/**
 * #2568 — `pnpm eval:code-pass-live`'s arguments and its requirement selection,
 * checked before the script builds a provider: a bad flag must not start a paid
 * run that spends its budget on nothing.
 */

export interface CodePassLiveArgs {
  mode: "explore" | "fast";
  budgetUsd: number;
  /** How many requirements to paste into the one code pass. */
  requirements: number;
  /** Take every `items`-th held-out item. */
  items: number;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  // A flag given with no value reads as "", which every check below refuses.
  return i < 0 ? undefined : (argv[i + 1] ?? "");
}

function positiveInteger(argv: readonly string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`--${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

export function parseCodePassLiveArgs(argv: readonly string[]): CodePassLiveArgs {
  const mode = flag(argv, "mode");
  if (mode !== "explore" && mode !== "fast") throw new Error("--mode explore|fast is required");
  const budgetUsd = Number(flag(argv, "budget") ?? "1.5");
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("--budget must be > 0");
  return {
    mode,
    budgetUsd,
    requirements: positiveInteger(argv, "requirements", 5),
    items: positiveInteger(argv, "items", 5),
  };
}

/** Every `items`-th item, the first `requirements` of them; refuses an empty selection. */
export function selectLiveItems<T>(
  all: readonly T[],
  args: Pick<CodePassLiveArgs, "items" | "requirements">,
): T[] {
  const picked = all.filter((_, i) => i % args.items === 0).slice(0, args.requirements);
  if (picked.length === 0) {
    throw new Error("no held-out items selected: check --items and --requirements");
  }
  return picked;
}
