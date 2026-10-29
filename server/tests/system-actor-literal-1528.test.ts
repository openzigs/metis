/**
 * #1528 — system-initiated work names its actor with `SYSTEM_ACTOR_ID`
 * (`src/lib/audit/system-actor.ts`), not the bare literal `"system"`.
 *
 * The literal was passed at ~20 call sites while the constant went unused, so
 * nothing tied them to the one place that decides how a system actor is stored
 * (`buildAuditLogData`, `createAnalysis`). A static ratchet over `src/`: an actor
 * id field, or a `?? "system"` fallback, spelled with the literal fails here.
 * It does not judge other uses of the word (chat roles, stop-word lists).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const ACTOR_LITERAL = [
  /\b(?:id|userId|actorId|startedById)\s*:\s*["']system["']/,
  /\?\?\s*["']system["']/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return sourceFiles(full);
    return d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe('#1528 — no bare "system" actor id in src/', () => {
  it("every system actor id is SYSTEM_ACTOR_ID", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (ACTOR_LITERAL.some((re) => re.test(line))) {
            hits.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it("the patterns catch the shapes that were in the tree", () => {
    for (const line of [
      'actor: { id: "system" },',
      'userId: "system",',
      'orchestrator.start({ projectId, startedById: "system" })',
      'actorId: req.user?.userId ?? "system",',
    ]) {
      expect(
        ACTOR_LITERAL.some((re) => re.test(line)),
        line,
      ).toBe(true);
    }
    expect(ACTOR_LITERAL.some((re) => re.test('role: z.enum(["system", "user"])'))).toBe(false);
  });
});
