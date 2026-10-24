/**
 * #1445 — the playground's "the owner may test it before enabling it"
 * exception is bound to ONE route (`POST /custom-agents/:id/invoke`), not to
 * anything a request says. If a chat, ACP or analysis code path ever imported
 * the playground rule, a request on that path could run an agent that is off
 * until enabled. So: the rule's symbols are referenced from the module that
 * defines them and from the playground route, and from nowhere else.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYMBOLS = /\b(customAgentPlaygroundUsable|isCustomAgentPlaygroundUsable)\b/;
const ALLOWED = new Set(["lib/agent-runtime/definition.ts", "routes/custom-agents.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("#1445 — the playground exception is scoped to the playground route", () => {
  it("only the defining module and the playground route reference the playground rule", () => {
    const users = sourceFiles(SRC)
      .filter((f) => SYMBOLS.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f).split(sep).join("/"))
      .sort();
    expect(users).toEqual([...ALLOWED].sort());
  });
});
