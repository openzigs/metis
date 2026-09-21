/**
 * SessionRuntime + searchLibrary + LibraryImporter tests.
 *
 * The `prisma` module is mocked once here to share the in-memory store with
 * the singleton service factories used by SessionRuntime + searchLibrary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma.js", async () => {
  const { fakePrisma } = await import("./fake-prisma.js");
  return { prisma: fakePrisma };
});

import { fakePrisma, getStore, resetStore, stubAgentToolRegistry } from "./fake-prisma.js";
import { SkillService, __setSkillService } from "../../src/lib/library/skill-service.js";
import { AgentService, __setAgentService } from "../../src/lib/library/agent-service.js";
import {
  SessionRuntime,
  SessionRuntimeError,
  __setSessionRuntime,
  renderSkillSystemBlock,
  renderAgentSystemMessage,
  getSessionRuntime,
} from "../../src/lib/library/session-runtime.js";
import { searchLibrary } from "../../src/lib/library/search.js";
import {
  FilesystemLoader,
  InlineLoader,
  LibraryImporter,
  LibraryImportError,
  RepoLoader,
  autoDiscoverFromWorkspace,
} from "../../src/lib/library/import.js";

const ACTOR = { id: "user_actor", role: "admin" };

const skillSrc = (name: string) => `---
name: ${name}
description: Skill ${name}
version: 1.0.0
tools: [github]
tags: [shared]
---

Body for ${name}
`;

const agentSrc = (name: string) => `---
name: ${name}
displayName: ${name}
description: Agent ${name}
version: 1.0.0
model: gpt
---

System prompt for ${name}.
`;

beforeEach(() => {
  resetStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setSkillService(new SkillService(fakePrisma as any));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setAgentService(new AgentService(fakePrisma as any, stubAgentToolRegistry));
  __setSessionRuntime(new SessionRuntime({ db: fakePrisma as never }));
});

afterEach(() => {
  __setSkillService(null);
  __setAgentService(null);
  __setSessionRuntime(null);
});

describe("SessionRuntime.loadSkillIntoSession", () => {
  it("loads a skill, persists the id, and is idempotent", async () => {
    const skill = await new SkillService(fakePrisma as never).create(
      { source: skillSrc("aa") },
      ACTOR,
    );
    const session = await fakePrisma.aISession.create({
      data: {
        userId: ACTOR.id,
        projectId: null,
        title: "t",
        provider: "p",
        model: "m",
        policy: "{}",
      },
    });
    const runtime = getSessionRuntime();
    const first = await runtime.loadSkillIntoSession(
      { sessionId: session.id, skillKey: "aa" },
      ACTOR,
    );
    expect(first.alreadyLoaded).toBe(false);
    expect(first.systemBlock).toContain("[skill:aa@1.0.0]");
    expect(first.loadedSkillIds).toEqual([skill.id]);
    const second = await runtime.loadSkillIntoSession(
      { sessionId: session.id, skillId: skill.id },
      ACTOR,
    );
    expect(second.alreadyLoaded).toBe(true);
    const audits = getStore().audit.map((a) => a.action);
    expect(audits).toContain("skill.load");
    expect(audits).toContain("skill.load.noop");
  });

  it("requires either skillId or skillKey", async () => {
    const session = await fakePrisma.aISession.create({
      data: {
        userId: ACTOR.id,
        projectId: null,
        title: "t",
        provider: "p",
        model: "m",
        policy: "{}",
      },
    });
    await expect(
      getSessionRuntime().loadSkillIntoSession({ sessionId: session.id }, ACTOR),
    ).rejects.toThrow(/SKILL_REF_REQUIRED/);
  });

  it("404s when the session is missing", async () => {
    const skill = await new SkillService(fakePrisma as never).create(
      { source: skillSrc("bb") },
      ACTOR,
    );
    await expect(
      getSessionRuntime().loadSkillIntoSession({ sessionId: "nope", skillId: skill.id }, ACTOR),
    ).rejects.toThrow(/SESSION_NOT_FOUND/);
  });

  it("rejects archived skills with SKILL_NOT_AVAILABLE", async () => {
    const skillSvc = new SkillService(fakePrisma as never);
    const skill = await skillSvc.create({ source: skillSrc("cc") }, ACTOR);
    await skillSvc.archive(skill.id, ACTOR);
    const session = await fakePrisma.aISession.create({
      data: {
        userId: ACTOR.id,
        projectId: null,
        title: "t",
        provider: "p",
        model: "m",
        policy: "{}",
      },
    });
    await expect(
      getSessionRuntime().loadSkillIntoSession({ sessionId: session.id, skillId: skill.id }, ACTOR),
    ).rejects.toThrow(/SKILL_NOT_AVAILABLE/);
  });

  it("returns 404 when skill key is missing entirely", async () => {
    const session = await fakePrisma.aISession.create({
      data: {
        userId: ACTOR.id,
        projectId: null,
        title: "t",
        provider: "p",
        model: "m",
        policy: "{}",
      },
    });
    await expect(
      getSessionRuntime().loadSkillIntoSession({ sessionId: session.id, skillKey: "ghost" }, ACTOR),
    ).rejects.toThrow(/SKILL_NOT_FOUND/);
  });
});

describe("SessionRuntime.listLoadedSkills", () => {
  it("preserves load order and ignores deleted skills", async () => {
    const svc = new SkillService(fakePrisma as never);
    const a = await svc.create({ source: skillSrc("a1") }, ACTOR);
    const b = await svc.create({ source: skillSrc("b1") }, ACTOR);
    const session = await fakePrisma.aISession.create({
      data: {
        userId: ACTOR.id,
        projectId: null,
        title: "t",
        provider: "p",
        model: "m",
        policy: "{}",
        loadedSkillIds: JSON.stringify([b.id, a.id]),
      },
    });
    const out = await getSessionRuntime().listLoadedSkills(session.id, ACTOR);
    expect(out.map((s) => s.key)).toEqual(["b1", "a1"]);
  });

  it("404s when the session is missing", async () => {
    await expect(getSessionRuntime().listLoadedSkills("none", ACTOR)).rejects.toThrow(
      /SESSION_NOT_FOUND/,
    );
  });
});

describe("SessionRuntime.resolveAgentForSession", () => {
  it("returns the system message + auto-loaded skill ids in order", async () => {
    const skillSvc = new SkillService(fakePrisma as never);
    await skillSvc.create({ source: skillSrc("auto1") }, ACTOR);
    await skillSvc.create({ source: skillSrc("auto2") }, ACTOR);
    const agentSvc = new AgentService(fakePrisma as never, stubAgentToolRegistry);
    const agent = await agentSvc.create(
      { source: agentSrc("orchestrator"), defaultSkillKeys: ["auto1", "auto2"] },
      ACTOR,
    );
    const out = await getSessionRuntime().resolveAgentForSession({ agentId: agent.id });
    expect(out.systemMessage).toContain("[agent:orchestrator@1.0.0]");
    expect(out.autoLoadedSkillIds).toHaveLength(2);
    expect(out.autoLoadedSkillBlocks[0]).toMatch(/skill:auto1/);
  });

  it("requires either agentId or agentKey", async () => {
    await expect(getSessionRuntime().resolveAgentForSession({})).rejects.toThrow(
      SessionRuntimeError,
    );
  });

  it("rejects disabled agents", async () => {
    const agentSvc = new AgentService(fakePrisma as never, stubAgentToolRegistry);
    const agent = await agentSvc.create({ source: agentSrc("dorm") }, ACTOR);
    await agentSvc.setEnabled(agent.id, false, ACTOR);
    await expect(getSessionRuntime().resolveAgentForSession({ agentKey: "dorm" })).rejects.toThrow(
      /AGENT_NOT_AVAILABLE/,
    );
  });

  it("404s on missing agents", async () => {
    await expect(getSessionRuntime().resolveAgentForSession({ agentKey: "ghost" })).rejects.toThrow(
      /AGENT_NOT_FOUND/,
    );
  });
});

describe("renderSkillSystemBlock + renderAgentSystemMessage", () => {
  it("renders skills with header + body", () => {
    const out = renderSkillSystemBlock({
      key: "k",
      name: "K",
      version: "1",
      description: "d",
      instructions: "B",
    });
    expect(out).toBe("[skill:k@1] K\nd\n\nB");
  });
  it("omits body separator when empty", () => {
    const out = renderSkillSystemBlock({
      key: "k",
      name: "K",
      version: "1",
      description: "",
      instructions: "",
    });
    expect(out).toBe("[skill:k@1] K");
  });
  it("agent picks displayName when provided", () => {
    const out = renderAgentSystemMessage({
      key: "a",
      name: "n",
      displayName: "Display",
      version: "v",
      description: "d",
      systemPrompt: "p",
    });
    expect(out.startsWith("[agent:a@v] Display")).toBe(true);
  });
});

describe("searchLibrary", () => {
  it("merges skills + agents and respects kind filters", async () => {
    const skillSvc = new SkillService(fakePrisma as never);
    const agentSvc = new AgentService(fakePrisma as never, stubAgentToolRegistry);
    __setSkillService(skillSvc);
    __setAgentService(agentSvc);
    await skillSvc.create({ source: skillSrc("findme") }, ACTOR);
    await agentSvc.create({ source: agentSrc("findme-agent") }, ACTOR);
    const all = await searchLibrary();
    expect(all).toHaveLength(2);
    const onlySkills = await searchLibrary({ kinds: ["skill"] });
    expect(onlySkills.every((h) => h.kind === "skill")).toBe(true);
    const tagged = await searchLibrary({ tag: "shared" });
    expect(tagged).toHaveLength(1);
    const queried = await searchLibrary({ query: "findme" });
    expect(queried.length).toBeGreaterThan(0);
  });
});

describe("InlineLoader", () => {
  it("returns its supplied files and a stable origin", async () => {
    const loader = new InlineLoader([{ path: "a.md", contents: skillSrc("inline") }]);
    expect(loader.origin()).toBe("inline");
    const files = await loader.load();
    expect(files).toHaveLength(1);
  });
});

describe("FilesystemLoader", () => {
  it("rejects relative roots", () => {
    expect(() => new FilesystemLoader("./nope", "skills")).toThrow(LibraryImportError);
  });

  it("walks directories, ignores symlinks, and skips path escapes", async () => {
    const root = "/abs/library";
    const fakeFs = {
      readdir: vi.fn(async (dir: string, _opts: unknown) => {
        if (dir === "/abs/library") {
          return [
            {
              name: "skill.md",
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            },
            {
              name: "evil.md",
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => true,
            },
            {
              name: "sub",
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
            {
              name: "..",
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        if (dir === "/abs/library/sub") {
          return [
            {
              name: "nested.skill.md",
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            },
          ];
        }
        if (dir === "/abs") {
          throw new Error("attempt to read parent");
        }
        return [];
      }),
      readFile: vi.fn(async (p: string) => `---\nname: ${path.basename(p)}\n---\nbody\n`),
    } as never;
    const loader = new FilesystemLoader(root, "skills", fakeFs);
    expect(loader.origin()).toBe("filesystem:/abs/library");
    const files = await loader.load();
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["skill.md", "sub/nested.skill.md"]);
  });
});

describe("RepoLoader", () => {
  it("filters by file naming and reads contents", async () => {
    const fetcher = {
      list: vi.fn(async () => [
        { path: "skills/SKILL.md", type: "file" as const },
        { path: "skills/notes.txt", type: "file" as const },
        { path: "skills/feature.skill.md", type: "file" as const },
        { path: "skills/sub", type: "dir" as const },
      ]),
      read: vi.fn(async (p: string) => `---\nname: ${p}\n---\nbody`),
    };
    const loader = new RepoLoader(fetcher, "skills", "abc123", "skills");
    expect(loader.origin()).toBe("repo:abc123");
    const files = await loader.load();
    expect(files.map((f) => f.path)).toEqual(["skills/SKILL.md", "skills/feature.skill.md"]);
  });

  it("agent matcher filters .agent.md only", async () => {
    const fetcher = {
      list: vi.fn(async () => [
        { path: "agents/A.agent.md", type: "file" as const },
        { path: "agents/B.txt", type: "file" as const },
      ]),
      read: vi.fn(async () => `---\nname: x\n---\nbody`),
    };
    const loader = new RepoLoader(fetcher, "agents", "ref", "agents");
    const files = await loader.load();
    expect(files.map((f) => f.path)).toEqual(["agents/A.agent.md"]);
  });
});

describe("LibraryImporter", () => {
  it("imports skills, skips key conflicts, and reports parse failures", async () => {
    const loader = new InlineLoader([
      { path: "ok.md", contents: skillSrc("ok") },
      { path: "dup.md", contents: skillSrc("ok") },
      { path: "bad.md", contents: "not-a-frontmatter-doc" },
    ]);
    const importer = new LibraryImporter();
    const result = await importer.importSkills(loader, ACTOR);
    expect(result.imported).toHaveLength(1);
    expect(result.skipped[0].path).toBe("dup.md");
    expect(result.failed[0].path).toBe("bad.md");
  });

  it("imports agents with the same skip+fail semantics", async () => {
    const loader = new InlineLoader([
      { path: "a.md", contents: agentSrc("imp-a") },
      { path: "b.md", contents: agentSrc("imp-a") },
      { path: "c.md", contents: "broken" },
    ]);
    const result = await new LibraryImporter().importAgents(loader, ACTOR);
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
  });
});

describe("autoDiscoverFromWorkspace", () => {
  it("never throws when the directories are missing \u2014 returns empty results", async () => {
    const out = await autoDiscoverFromWorkspace("/tmp/does-not-exist-metis-test", ACTOR);
    expect(out.skills.imported).toHaveLength(0);
    expect(out.agents.imported).toHaveLength(0);
  });
});

describe("SessionRuntime project allow-list enforcement (issue #74 follow-up)", () => {
  it("rejects skills not on the project allow-list with PROJECT_SKILL_NOT_ALLOWED", async () => {
    const skillSvc = new SkillService(fakePrisma as never);
    const allowed = await skillSvc.create({ source: skillSrc("ok-skill") }, ACTOR);
    const blocked = await skillSvc.create({ source: skillSrc("nope-skill") }, ACTOR);
    const project = await fakePrisma.project.create({
      data: { name: "P", slug: "p", createdById: ACTOR.id },
    });
    // Pin the allow-list to one skill — anything else must be rejected.
    await fakePrisma.projectSkillAllowlist.upsert({
      where: { projectId_skillId: { projectId: project.id, skillId: allowed.id } },
      create: { projectId: project.id, skillId: allowed.id, enabled: true, addedById: ACTOR.id },
      update: { enabled: true },
    });
    const session = await fakePrisma.aISession.create({
      data: {
        userId: ACTOR.id,
        projectId: project.id,
        title: "t",
        provider: "p",
        model: "m",
        policy: "{}",
      },
    });
    await expect(
      getSessionRuntime().loadSkillIntoSession(
        { sessionId: session.id, skillId: blocked.id },
        ACTOR,
      ),
    ).rejects.toThrow(/PROJECT_SKILL_NOT_ALLOWED/);
    // The allowed skill still loads.
    const loaded = await getSessionRuntime().loadSkillIntoSession(
      { sessionId: session.id, skillId: allowed.id },
      ACTOR,
    );
    expect(loaded.alreadyLoaded).toBe(false);
  });

  it("bypasses allow-list enforcement when the session has no projectId", async () => {
    const skillSvc = new SkillService(fakePrisma as never);
    const skill = await skillSvc.create({ source: skillSrc("free") }, ACTOR);
    const session = await fakePrisma.aISession.create({
      data: {
        userId: ACTOR.id,
        projectId: null,
        title: "t",
        provider: "p",
        model: "m",
        policy: "{}",
      },
    });
    const loaded = await getSessionRuntime().loadSkillIntoSession(
      { sessionId: session.id, skillId: skill.id },
      ACTOR,
    );
    expect(loaded.alreadyLoaded).toBe(false);
  });
});

describe("SessionRuntime.materializeSkillsForSession (issue #113)", () => {
  it("writes loaded skills under <copilotHome>/skills/<key>/SKILL.md", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const tmpRoot = await fs.mkdtemp(pathMod.join(os.tmpdir(), "metis-mat-"));
    const skillSvc = new SkillService(fakePrisma as never);
    const a = await skillSvc.create({ source: skillSrc("alpha") }, ACTOR);
    const b = await skillSvc.create({ source: skillSrc("beta") }, ACTOR);
    const result = await getSessionRuntime().materializeSkillsForSession({
      sessionId: "s1",
      copilotHome: tmpRoot,
      loadedSkillIds: [a.id, b.id],
    });
    expect(result.skillsDir).toBe(pathMod.join(tmpRoot, "skills"));
    expect(result.written.sort()).toEqual(["alpha", "beta"]);
    expect(result.disabledSkills).toEqual([]);
    const alphaContent = await fs.readFile(
      pathMod.join(result.skillsDir, "alpha", "SKILL.md"),
      "utf-8",
    );
    expect(alphaContent).toContain('name: "alpha"');
    expect(alphaContent).toContain("Body for alpha");
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("honours disabledSkillKeys \u2014 those keys are NOT written and are surfaced for the SDK", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const tmpRoot = await fs.mkdtemp(pathMod.join(os.tmpdir(), "metis-mat-"));
    const skillSvc = new SkillService(fakePrisma as never);
    const a = await skillSvc.create({ source: skillSrc("good") }, ACTOR);
    const b = await skillSvc.create({ source: skillSrc("muted") }, ACTOR);
    const result = await getSessionRuntime().materializeSkillsForSession({
      sessionId: "s2",
      copilotHome: tmpRoot,
      loadedSkillIds: [a.id, b.id],
      disabledSkillKeys: ["muted"],
    });
    expect(result.written).toEqual(["good"]);
    expect(result.disabledSkills).toContain("muted");
    const exists = await fs
      .access(pathMod.join(result.skillsDir, "muted", "SKILL.md"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns an empty written list when no skills are loaded but still creates the skills dir", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const tmpRoot = await fs.mkdtemp(pathMod.join(os.tmpdir(), "metis-mat-"));
    const result = await getSessionRuntime().materializeSkillsForSession({
      sessionId: "s3",
      copilotHome: tmpRoot,
      loadedSkillIds: [],
    });
    expect(result.written).toEqual([]);
    const stat = await fs.stat(result.skillsDir);
    expect(stat.isDirectory()).toBe(true);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("removes stale skill directories from a previous load", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const tmpRoot = await fs.mkdtemp(pathMod.join(os.tmpdir(), "metis-mat-"));
    const skillSvc = new SkillService(fakePrisma as never);
    const a = await skillSvc.create({ source: skillSrc("first") }, ACTOR);
    const b = await skillSvc.create({ source: skillSrc("second") }, ACTOR);
    await getSessionRuntime().materializeSkillsForSession({
      sessionId: "s4",
      copilotHome: tmpRoot,
      loadedSkillIds: [a.id, b.id],
    });
    // Now narrow to just `b` — `first` directory must be cleaned.
    await getSessionRuntime().materializeSkillsForSession({
      sessionId: "s4",
      copilotHome: tmpRoot,
      loadedSkillIds: [b.id],
    });
    const skillsDir = pathMod.join(tmpRoot, "skills");
    const remaining = await fs.readdir(skillsDir);
    expect(remaining).toEqual(["second"]);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
});

// Re-imported here so the fakeFs callback can use it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
