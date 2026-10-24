/**
 * #1445 — the playground's "test it before you enable it" exception is bound
 * to ONE route (`POST /custom-agents/:id/invoke`), not to anything a request
 * says. If a chat, ACP or analysis code path ever reached the playground rule,
 * a request on that path could run an agent that is off until enabled.
 *
 * Two source guards:
 *   1. the rule's symbols are referenced only from the module that defines
 *      them and from the playground route;
 *   2. no OTHER module that selects custom agents re-derives the exception
 *      inline by comparing an agent's owning project with the project it runs
 *      in (`agentProjectId === projectId`, `def.projectId === projectId`, …).
 *
 * Limitation: guard 2 matches an equality between two `…projectId` operands.
 * An owner check written another way (a `Set` lookup, a helper with another
 * name) would pass it. It catches the regression that is easy to write, not
 * every possible one; the behavioural tests in
 * `disabled-custom-agent-1005.test.ts` and the ACP and route suites are what
 * pin the rule itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYMBOLS = /\b(customAgentPlaygroundAccess|customAgentPlaygroundAccessFor)\b/;
const ALLOWED = new Set(["lib/agent-runtime/definition.ts", "routes/custom-agents.ts"]);
/** A module that touches custom agents at all (by name, any case). */
const SELECTS_CUSTOM_AGENTS = /customAgent/i;
/** `x.projectId === y.projectId`, `agentProjectId !== projectId`, … */
const OWNER_EQUALS_PROJECT = /\b[\w.]*projectId\s*[!=]==?\s*[\w.]*projectId\b/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (f: string) => relative(SRC, f).split(sep).join("/");

describe("#1445 — the playground exception is scoped to the playground route", () => {
  it("only the defining module and the playground route reference the playground rule", () => {
    const users = sourceFiles(SRC)
      .filter((f) => SYMBOLS.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(users).toEqual([...ALLOWED].sort());
  });

  it("no other module that selects custom agents gates them on owner === project", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !ALLOWED.has(rel(f)))
      .flatMap((f) => {
        const text = readFileSync(f, "utf8");
        if (!SELECTS_CUSTOM_AGENTS.test(text)) return [];
        return text
          .split("\n")
          .map((line, i) => ({ line: line.trim(), at: `${rel(f)}:${i + 1}` }))
          .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"))
          .filter(({ line }) => OWNER_EQUALS_PROJECT.test(line))
          .map(({ at, line }) => `${at} ${line}`);
      });
    expect(offenders).toEqual([]);
  });
});
