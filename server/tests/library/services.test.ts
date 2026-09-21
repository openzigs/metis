/**
 * SkillService + AgentService + ProjectLibraryAllowlistService tests.
 *
 * Uses an in-memory `fakePrisma` injected via constructor \u2014 no module mocking
 * required. Audit writes are routed through the real audit-service which is
 * itself wired to the same fake `prisma`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma.js", async () => {
  const { fakePrisma } = await import("./fake-prisma.js");
  return { prisma: fakePrisma };
});

import { fakePrisma, getStore, resetStore, stubAgentToolRegistry } from "./fake-prisma.js";
import { SkillService, SkillServiceError } from "../../src/lib/library/skill-service.js";
import { AgentService, AgentServiceError } from "../../src/lib/library/agent-service.js";
import {
  AllowlistError,
  ProjectLibraryAllowlistService,
} from "../../src/lib/library/project-allowlist.js";

const ACTOR = { id: "user_actor", role: "admin" };

const skillSrc = (name: string, version = "1.0.0", tags: string[] = []) => `---
name: ${name}
description: Skill ${name}
version: ${version}
tools: [github]
tags: [${tags.join(", ")}]
---

Body for ${name} ${version}
`;

const agentSrc = (name: string, version = "1.0.0") => `---
name: ${name}
displayName: ${name}
description: Agent ${name}
version: ${version}
model: gpt
tools: [github]
---

System prompt for ${name}.
`;

beforeEach(() => {
  resetStore();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svcSkill = (): SkillService => new SkillService(fakePrisma as any);
// Stub ToolRegistry that knows about the tool names referenced in test
// agent fixtures. Mirrors the wildcard contract so existing tests don't
// have to re-declare the shape of every ref.
const stubToolRegistry = stubAgentToolRegistry;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svcAgent = (): AgentService => new AgentService(fakePrisma as any, stubToolRegistry);
const svcAllow = (): ProjectLibraryAllowlistService =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new ProjectLibraryAllowlistService(fakePrisma as any);

describe("SkillService", () => {
  it("creates a skill, lists it, fetches by key", async () => {
    const svc = svcSkill();
    const created = await svc.create({ source: skillSrc("alpha", "1.0.0", ["dev"]) }, ACTOR);
    expect(created.key).toBe("alpha");
    expect(created.version).toBe("1.0.0");
    expect(created.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    const list = await svc.list();
    expect(list).toHaveLength(1);
    const tagged = await svc.list({ tag: "dev" });
    expect(tagged).toHaveLength(1);
    const empty = await svc.list({ tag: "missing" });
    expect(empty).toHaveLength(0);

    const byKey = await svc.getByKey("alpha");
    expect(byKey?.id).toBe(created.id);
  });

  it("rejects duplicate keys for live skills", async () => {
    const svc = svcSkill();
    await svc.create({ source: skillSrc("alpha") }, ACTOR);
    await expect(svc.create({ source: skillSrc("alpha") }, ACTOR)).rejects.toThrow(
      SkillServiceError,
    );
  });

  it("revives a soft-deleted skill on re-create", async () => {
    const svc = svcSkill();
    const first = await svc.create({ source: skillSrc("revive") }, ACTOR);
    await svc.remove(first.id, ACTOR);
    const revived = await svc.create({ source: skillSrc("revive", "2.0.0") }, ACTOR);
    expect(revived.id).toBe(first.id);
    expect(revived.version).toBe("2.0.0");
  });

  it("update bumps version + records SkillVersion row", async () => {
    const svc = svcSkill();
    const created = await svc.create({ source: skillSrc("beta", "1.0.0") }, ACTOR);
    const updated = await svc.update(
      created.id,
      { source: skillSrc("beta", "1.0.0").replace("Body", "Body v2") },
      ACTOR,
    );
    expect(updated.version).toBe("1.0.1");
    const versions = await svc.listVersions(created.id);
    expect(versions).toHaveLength(2);
    const shas = await Promise.all(
      versions.map(async (v) => (await svc.getVersion(created.id, v.id))!.contentSha256),
    );
    expect(shas).toContain(updated.contentSha256);
    const diff = await svc.diff(created.id, versions[0].id, versions[1].id);
    expect(diff.left?.version).not.toBe(diff.right?.version);
  });

  it("throws SKILL_NO_CHANGE on identical content", async () => {
    const svc = svcSkill();
    const src = skillSrc("nochange");
    const created = await svc.create({ source: src }, ACTOR);
    await expect(svc.update(created.id, { source: src }, ACTOR)).rejects.toThrow(/SKILL_NO_CHANGE/);
  });

  it("returns null for missing skills + throws on update of unknown id", async () => {
    const svc = svcSkill();
    expect(await svc.get("nope")).toBeNull();
    expect(await svc.getByKey("nope")).toBeNull();
    await expect(svc.update("missing", { source: skillSrc("x") }, ACTOR)).rejects.toThrow(
      /SKILL_NOT_FOUND/,
    );
    await expect(svc.archive("missing", ACTOR)).rejects.toThrow(/SKILL_NOT_FOUND/);
    await expect(svc.remove("missing", ACTOR)).rejects.toThrow(/SKILL_NOT_FOUND/);
    await expect(svc.setEnabled("missing", false, ACTOR)).rejects.toThrow(/SKILL_NOT_FOUND/);
  });

  it("archive flips archived flag + disables", async () => {
    const svc = svcSkill();
    const created = await svc.create({ source: skillSrc("arc") }, ACTOR);
    const archived = await svc.archive(created.id, ACTOR);
    expect(archived.archived).toBe(true);
    expect(archived.enabled).toBe(false);
    const disabled = await svc.setEnabled(created.id, false, ACTOR);
    expect(disabled.enabled).toBe(false);
    const enabled = await svc.setEnabled(created.id, true, ACTOR);
    expect(enabled.enabled).toBe(true);
  });
});

describe("AgentService", () => {
  it("creates and fetches an agent with default skill links", async () => {
    const skillSvc = svcSkill();
    await skillSvc.create({ source: skillSrc("companion") }, ACTOR);
    const agentSvc = svcAgent();
    const agent = await agentSvc.create(
      { source: agentSrc("primary", "1.0.0"), defaultSkillKeys: ["companion"] },
      ACTOR,
    );
    expect(agent.key).toBe("primary");
    expect(agent.defaultSkillKeys).toEqual(["companion"]);
    const got = await agentSvc.get(agent.id);
    expect(got?.id).toBe(agent.id);
    const byKey = await agentSvc.getByKey("primary");
    expect(byKey?.id).toBe(agent.id);
  });

  it("rejects defaultSkillKeys that point to missing skills", async () => {
    const agentSvc = svcAgent();
    await expect(
      agentSvc.create({ source: agentSrc("bad"), defaultSkillKeys: ["ghost"] }, ACTOR),
    ).rejects.toThrow(/SKILL_REF_NOT_FOUND/);
  });

  it("rejects defaultSkillKeys that reference disabled skills", async () => {
    const skillSvc = svcSkill();
    const skill = await skillSvc.create({ source: skillSrc("offline") }, ACTOR);
    await skillSvc.setEnabled(skill.id, false, ACTOR);
    const agentSvc = svcAgent();
    await expect(
      agentSvc.create({ source: agentSrc("ag"), defaultSkillKeys: ["offline"] }, ACTOR),
    ).rejects.toThrow(/SKILL_REF_DISABLED/);
  });

  it("update bumps version + creates AgentVersion row", async () => {
    const skillSvc = svcSkill();
    await skillSvc.create({ source: skillSrc("k1") }, ACTOR);
    const agentSvc = svcAgent();
    const created = await agentSvc.create(
      { source: agentSrc("evo"), defaultSkillKeys: ["k1"] },
      ACTOR,
    );
    const updated = await agentSvc.update(
      created.id,
      { source: agentSrc("evo").replace("System prompt", "System prompt v2") },
      ACTOR,
    );
    expect(updated.version).toBe("1.0.1");
    const versions = await agentSvc.listVersions(created.id);
    expect(versions).toHaveLength(2);
    const shas = await Promise.all(
      versions.map(async (v) => (await agentSvc.getVersion(created.id, v.id))!.contentSha256),
    );
    expect(shas).toContain(updated.contentSha256);
  });

  it("throws AGENT_NO_CHANGE on identical content", async () => {
    const agentSvc = svcAgent();
    const src = agentSrc("steady");
    const a = await agentSvc.create({ source: src }, ACTOR);
    await expect(agentSvc.update(a.id, { source: src }, ACTOR)).rejects.toThrow(/AGENT_NO_CHANGE/);
  });

  it("rejects duplicate agent keys", async () => {
    const agentSvc = svcAgent();
    await agentSvc.create({ source: agentSrc("dup") }, ACTOR);
    await expect(agentSvc.create({ source: agentSrc("dup") }, ACTOR)).rejects.toThrow(
      AgentServiceError,
    );
  });

  it("404s on missing agent for read + write methods", async () => {
    const agentSvc = svcAgent();
    expect(await agentSvc.get("missing")).toBeNull();
    expect(await agentSvc.getByKey("missing")).toBeNull();
    await expect(agentSvc.update("missing", { source: agentSrc("x") }, ACTOR)).rejects.toThrow(
      /AGENT_NOT_FOUND/,
    );
    await expect(agentSvc.archive("missing", ACTOR)).rejects.toThrow(/AGENT_NOT_FOUND/);
    await expect(agentSvc.remove("missing", ACTOR)).rejects.toThrow(/AGENT_NOT_FOUND/);
    await expect(agentSvc.setEnabled("missing", false, ACTOR)).rejects.toThrow(/AGENT_NOT_FOUND/);
  });
});

describe("ProjectLibraryAllowlistService", () => {
  it("default-allows all enabled skills/agents when no rows exist", async () => {
    const skillSvc = svcSkill();
    const agentSvc = svcAgent();
    const a = await skillSvc.create({ source: skillSrc("aa") }, ACTOR);
    const b = await skillSvc.create({ source: skillSrc("bb") }, ACTOR);
    await skillSvc.setEnabled(b.id, false, ACTOR);
    const ag = await agentSvc.create({ source: agentSrc("only") }, ACTOR);
    const allow = svcAllow();
    const projectId = "proj_1";
    const skillIds = await allow.resolveAllowedSkillIds(projectId);
    expect(skillIds.has(a.id)).toBe(true);
    expect(skillIds.has(b.id)).toBe(false);
    const agentIds = await allow.resolveAllowedAgentIds(projectId);
    expect(agentIds.has(ag.id)).toBe(true);
  });

  it("explicit allowlist wins, supports enable/disable + remove", async () => {
    const skillSvc = svcSkill();
    const a = await skillSvc.create({ source: skillSrc("c1") }, ACTOR);
    const b = await skillSvc.create({ source: skillSrc("c2") }, ACTOR);
    const allow = svcAllow();
    const projectId = "proj_2";
    await allow.setSkillEnabled(projectId, a.id, true, ACTOR);
    await allow.setSkillEnabled(projectId, b.id, false, ACTOR);
    const ids = await allow.resolveAllowedSkillIds(projectId);
    expect([...ids]).toEqual([a.id]);
    const list = await allow.listSkills(projectId);
    expect(list).toHaveLength(2);
    await allow.removeSkill(projectId, b.id, ACTOR);
    expect(getStore().projectSkillAllow.find((r) => r.skillId === b.id)).toBeUndefined();
  });

  it("agent allowlist mirrors skill allowlist semantics", async () => {
    const agentSvc = svcAgent();
    const a = await agentSvc.create({ source: agentSrc("alpha") }, ACTOR);
    const b = await agentSvc.create({ source: agentSrc("bravo") }, ACTOR);
    const allow = svcAllow();
    const projectId = "proj_3";
    await allow.setAgentEnabled(projectId, a.id, true, ACTOR);
    await allow.setAgentEnabled(projectId, b.id, false, ACTOR);
    const ids = await allow.resolveAllowedAgentIds(projectId);
    expect([...ids]).toEqual([a.id]);
    const list = await allow.listAgents(projectId);
    expect(list).toHaveLength(2);
    await allow.removeAgent(projectId, b.id, ACTOR);
    expect(getStore().projectAgentAllow.find((r) => r.agentId === b.id)).toBeUndefined();
  });

  it("resolveAvailableSkills returns enabled skills as display rows when no rows exist (#468)", async () => {
    const skillSvc = svcSkill();
    const a = await skillSvc.create({ source: skillSrc("avail-a") }, ACTOR);
    const b = await skillSvc.create({ source: skillSrc("avail-b") }, ACTOR);
    await skillSvc.setEnabled(b.id, false, ACTOR); // disabled → never offered
    const allow = svcAllow();
    const rows = await allow.resolveAvailableSkills("proj_avail");
    expect(rows.map((r) => r.skillId)).toContain(a.id);
    expect(rows.map((r) => r.skillId)).not.toContain(b.id);
    // display fields are projected, not just ids
    const row = rows.find((r) => r.skillId === a.id)!;
    expect(row.skillKey).toBe(a.key);
    expect(typeof row.name).toBe("string");
    expect(row).toHaveProperty("description");
  });

  it("resolveAvailableSkills honors an explicit allowlist (#468)", async () => {
    const skillSvc = svcSkill();
    const a = await skillSvc.create({ source: skillSrc("exp-a") }, ACTOR);
    const b = await skillSvc.create({ source: skillSrc("exp-b") }, ACTOR);
    const allow = svcAllow();
    const projectId = "proj_avail_explicit";
    await allow.setSkillEnabled(projectId, a.id, true, ACTOR);
    await allow.setSkillEnabled(projectId, b.id, false, ACTOR);
    const rows = await allow.resolveAvailableSkills(projectId);
    expect(rows.map((r) => r.skillId)).toEqual([a.id]);
  });

  it("throws AllowlistError when toggling unknown ids", async () => {
    const allow = svcAllow();
    await expect(allow.setSkillEnabled("p", "missing", true, ACTOR)).rejects.toThrow(
      AllowlistError,
    );
    await expect(allow.setAgentEnabled("p", "missing", true, ACTOR)).rejects.toThrow(
      AllowlistError,
    );
  });
});

describe("AgentService.validateToolRefs (issue #74 — save-time tool ref validation)", () => {
  const emptyRegistry = () =>
    ({ list: () => [] }) as unknown as import("../../src/lib/ai/tool-registry.js").ToolRegistry;

  const registryWithGithub = () =>
    ({
      list: () => [
        { name: "read_file", description: "x", risk: "low" as const },
        { name: "mcp:github:create_issue", description: "x", risk: "low" as const },
        { name: "mcp:github:list_issues", description: "x", risk: "low" as const },
      ],
    }) as unknown as import("../../src/lib/ai/tool-registry.js").ToolRegistry;

  const srcWithTools = (tools: string[]) => `---
name: tool-test
displayName: Tool Test
description: agent with custom tool refs
version: 1.0.0
model: gpt
tools: [${tools.join(", ")}]
---

System prompt body.
`;

  it("rejects unknown tool refs with AGENT_TOOL_REF_UNKNOWN listing the bad names", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new AgentService(fakePrisma as any, emptyRegistry);
    const promise = svc.create({ source: srcWithTools(["nope-tool", "another-bogus"]) }, ACTOR);
    await expect(promise).rejects.toThrow(/AGENT_TOOL_REF_UNKNOWN/);
    await expect(promise).rejects.toThrow(/nope-tool/);
    await expect(promise).rejects.toThrow(/another-bogus/);
  });

  it("accepts exact-name tool refs that exist in the registry", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new AgentService(fakePrisma as any, registryWithGithub);
    const created = await svc.create(
      { source: srcWithTools(["read_file", "mcp:github:create_issue"]) },
      ACTOR,
    );
    expect(created.tools).toEqual(["read_file", "mcp:github:create_issue"]);
  });

  it("accepts namespace wildcards like mcp:github:* when the namespace is registered", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new AgentService(fakePrisma as any, registryWithGithub);
    const created = await svc.create({ source: srcWithTools(["mcp:github:*"]) }, ACTOR);
    expect(created.tools).toEqual(["mcp:github:*"]);
  });

  it("rejects unknown namespace wildcards (typo'd prefix)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new AgentService(fakePrisma as any, registryWithGithub);
    await expect(svc.create({ source: srcWithTools(["mcp:gihub:*"]) }, ACTOR)).rejects.toThrow(
      /AGENT_TOOL_REF_UNKNOWN/,
    );
  });

  it("accepts the global mcp:* blanket grant without inspecting registered prefixes", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new AgentService(fakePrisma as any, emptyRegistry);
    const created = await svc.create({ source: srcWithTools(["mcp:*"]) }, ACTOR);
    expect(created.tools).toEqual(["mcp:*"]);
  });

  it("re-validates on update so adding an unknown tool fails after save", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new AgentService(fakePrisma as any, registryWithGithub);
    const created = await svc.create({ source: srcWithTools(["read_file"]) }, ACTOR);
    await expect(
      svc.update(created.id, { source: srcWithTools(["read_file", "ghost"]) }, ACTOR),
    ).rejects.toThrow(/AGENT_TOOL_REF_UNKNOWN/);
  });
});
