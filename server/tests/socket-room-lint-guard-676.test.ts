/**
 * #676 — a server emitter that writes a room name by hand can drift from the
 * room the client joined through the `@metis/shared` factory, and the emit then
 * lands in an empty room with nothing to say so. `eslint.config.mjs` bans a
 * hand-written room of each factory-built kind under `server/src`. This pins the
 * guard: it fires on each kind in every `no-restricted-syntax` block that covers
 * server code (flat config replaces the rule per block, so a block that forgets
 * the selector silently drops it), and it leaves event names and the factories
 * themselves alone.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The guard is pure AST matching, so type-aware linting (on for the socket
// modules) is switched off here: loading the server's TypeScript program costs
// seconds and would tie this test's runtime to a contended machine.
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfig: {
    languageOptions: { parserOptions: { projectService: false } },
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
});

const GUARD = /#676/;

async function roomFindings(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, file) });
  return result!.messages
    .filter((m) => m.ruleId === "no-restricted-syntax" && GUARD.test(m.message))
    .map((m) => code.split("\n")[m.line - 1]!.trim());
}

// One file per `no-restricted-syntax` block that covers server code.
const SERVER_FILES = [
  "server/src/lib/publishing/socket-emitter.ts",
  "server/src/routes/ai.ts",
  "server/src/lib/socket/server.ts",
  "server/src/lib/collaboration/presence.ts",
];

const KINDS = [
  "thread",
  "session",
  "task",
  "analysis",
  "publish",
  "connector",
  "job",
  "run",
  // #686
  "project",
  "user",
];

describe("hand-written socket room guard (#676)", () => {
  it.each(SERVER_FILES)("flags every hand-written room kind in %s", async (file) => {
    const lines = [
      "declare const id: string;",
      "declare const io: { to(room: string): unknown };",
      ...KINDS.map((kind) => `io.to(\`${kind}:\${id}\`);`),
      "io.to(`presence:${id}:${id}`);",
      ...KINDS.map((kind) => `io.to("${kind}:" + id);`),
      "export {};",
    ];
    const flagged = await roomFindings(lines.join("\n"), file);
    expect(flagged).toEqual(lines.filter((l) => l.startsWith("io.to(")));
  });

  it("leaves event names, factories, and other rooms alone", async () => {
    const code = [
      'import { jobRoom, bgRunRoom } from "@metis/shared";',
      "declare const id: string;",
      "declare const io: { to(room: string): { emit(e: string): void } };",
      'io.to(jobRoom(id)).emit("job:lifecycle");',
      "io.to(bgRunRoom(id)).emit(`job:lifecycle`);",
      "io.to(`scheduler:${id}`);",
      "const label = `connector:repo:${id}`;",
      "export { label };",
    ].join("\n");
    expect(await roomFindings(code, "server/src/lib/publishing/socket-emitter.ts")).toEqual([]);
  });

  // #686 — `user:{id}` is also every rate limiter's per-user bucket key and
  // `project:{label}` a vault secret's name; neither is a room. Those files
  // keep the guard for every other kind.
  const NON_ROOM_FILES = [
    "server/src/middleware/ai-rate-limit.ts",
    "server/src/middleware/mcp-admin-rate-limit.ts",
    "server/src/lib/pagerduty/service-config-store.ts",
    "server/src/lib/slack/installation-store.ts",
    "server/src/lib/teams/installation-store.ts",
  ];

  it.each(NON_ROOM_FILES)(
    "leaves user:/project: keys alone in %s but still flags the other room kinds",
    async (file) => {
      const lines = [
        "declare const id: string;",
        "declare const io: { to(room: string): unknown };",
        "const key = `user:${id}`;",
        'const name = "project:" + id;',
        ...KINDS.filter((k) => k !== "project" && k !== "user").map(
          (kind) => `io.to(\`${kind}:\${id}\`);`,
        ),
        "export { key, name };",
      ];
      const flagged = await roomFindings(lines.join("\n"), file);
      expect(flagged).toEqual(lines.filter((l) => l.startsWith("io.to(")));
    },
  );

  it("still flags user: and project: in a middleware file that is not a rate limiter", async () => {
    const lines = [
      "declare const id: string;",
      "declare const io: { to(room: string): unknown };",
      "io.to(`user:${id}`);",
      "io.to(`project:${id}`);",
      "export {};",
    ];
    const flagged = await roomFindings(lines.join("\n"), "server/src/middleware/auth.ts");
    expect(flagged).toEqual(lines.filter((l) => l.startsWith("io.to(")));
  });

  it("does not apply outside server/src, where the factories live", async () => {
    const code = "export const jobRoom = (jobId: string): string => `job:${jobId}`;";
    expect(await roomFindings(code, "packages/shared/src/socket-rooms.ts")).toEqual([]);
  });
});
