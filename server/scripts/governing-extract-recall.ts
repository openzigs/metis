/**
 * `pnpm governing:extract-recall` — #1870's recall check: run production's rule
 * extraction (`extractRulesFromText`) over the #1867 held-out policy with the
 * configured provider, and compare the control ids it stores with the corpus's
 * obligation list.
 *
 *   pnpm governing:extract-recall [--revision v1] [--record <file>]
 *
 * `--record` writes the provider's replies, in call order, as a fixture the unit
 * tests replay (`src/lib/governing/__fixtures__/`). It calls a model, so it
 * costs money: one call per section of the policy.
 */
/* eslint-disable no-console -- a CLI whose output is its report */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = path.join(ROOT, "eval-data", "corpus", "governing-01-sample-policy");

function flagValue(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

async function main(argv: string[]): Promise<number> {
  const revision = flagValue(argv, "revision") ?? "v1";
  const record = flagValue(argv, "record");
  const manifest = JSON.parse(readFileSync(path.join(CORPUS, "manifest.json"), "utf8")) as {
    policy: { title: string };
    rules: Array<{ id: string }>;
  };
  const text = readFileSync(path.join(CORPUS, `policy-${revision}.md`), "utf8");

  const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");
  const { extractRulesFromText } = await import("../src/lib/governing/rule-extraction.js");
  const live = buildProvider({ config: loadAIConfig() });
  if (live.offline)
    throw new Error("set AI_PROVIDER and its key: the offline stub extracts nothing");

  const replies: ChatResponse[] = [];
  const recording: AIProvider = Object.create(live) as AIProvider;
  recording.chat = async (messages, opts) => {
    const res = await live.chat(messages, opts);
    replies.push(res);
    return res;
  };

  const result = await extractRulesFromText({
    text,
    title: manifest.policy.title,
    revisionLabel: revision,
    provider: recording,
  });

  const expected = manifest.rules.map((r) => r.id);
  const stored = new Set(result.rules.map((r) => r.controlId));
  const found = expected.filter((id) => stored.has(id));
  const missing = expected.filter((id) => !stored.has(id));
  const extra = [...stored].filter((id) => !expected.includes(id));
  const tokens = replies.reduce(
    (t, r) => ({ in: t.in + r.usage.promptTokens, out: t.out + r.usage.completionTokens }),
    { in: 0, out: 0 },
  );
  console.log(
    [
      `provider       ${live.key}/${live.model}`,
      `policy         ${manifest.policy.title} ${revision} (${result.sections} sections, ${replies.length} calls)`,
      `rules stored   ${result.rules.length}`,
      `dropped        ${result.droppedUnverified} (excerpt not found verbatim)`,
      `recall         ${found.length}/${expected.length} = ${(found.length / expected.length).toFixed(3)}`,
      `missing        ${missing.join(", ") || "none"}`,
      `not in list    ${extra.join(", ") || "none"}`,
      `tokens         ${tokens.in} in, ${tokens.out} out`,
    ].join("\n"),
  );

  if (record) {
    writeFileSync(
      record,
      `${JSON.stringify(
        {
          recordedFrom: `${live.key}/${live.model}`,
          recordedAt: new Date().toISOString(),
          policy: `eval-data/corpus/governing-01-sample-policy/policy-${revision}.md`,
          title: manifest.policy.title,
          revisionLabel: revision,
          replies: replies.map((r) => r.content),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`recorded ${replies.length} replies to ${record}`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
