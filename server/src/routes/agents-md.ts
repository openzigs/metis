/**
 * /api/projects/:id/agents-md — AGENTS.md export + preview (#154).
 *
 * - GET /api/projects/:id/agents-md
 *     returns rendered Markdown (text/markdown).
 * - GET /api/projects/:id/agents-md/preview
 *     returns the structured detector JSON for live UI preview.
 */
import { Router } from "express";
import type { ApiResponse } from "@metis/shared";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { detectAgents } from "../lib/agents-md/detector.js";
import { generateAgentsMd } from "../lib/agents-md/generator.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

async function loadDetectorInput(projectId: string): Promise<{
  projectName: string;
  description?: string;
  defaultModel?: string;
  knownAgents: Array<{
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    model?: string | null;
    source: string;
  }>;
  mcpServers: Array<{ label: string; tools: string[] }>;
}> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      description: true,
      aiProviderId: true,
      aiModel: true,
    },
  });
  if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  const known = await prisma.knownAgentDefinition.findMany({ where: { projectId } });
  const knownAgents = known.map((k) => {
    let tools: string[] = [];
    try {
      const parsed = JSON.parse(k.tools);
      if (Array.isArray(parsed)) tools = parsed.filter((x) => typeof x === "string");
    } catch {
      tools = [];
    }
    return {
      name: k.name,
      description: k.description,
      systemPrompt: k.systemPrompt,
      tools,
      model: k.model,
      source: k.source,
    };
  });
  return {
    projectName: project.name,
    description: project.description || undefined,
    defaultModel: project.aiModel || undefined,
    knownAgents,
    mcpServers: [],
  };
}

export function projectAgentsMdRouter(): Router {
  const r = Router({ mergeParams: true });

  r.get("/agents-md/preview", requireAuth, requirePermission("project.read"), async (req, res) => {
    const projectId =
      (req.params as { projectId?: string; id?: string }).projectId ??
      (req.params as { id?: string }).id ??
      "";
    const input = await loadDetectorInput(projectId);
    const set = detectAgents({
      projectName: input.projectName,
      projectDescription: input.description,
      defaultModel: input.defaultModel,
      knownAgents: input.knownAgents,
      mcpServers: input.mcpServers,
    });
    res.json(ok(set));
  });

  r.get("/agents-md", requireAuth, requirePermission("project.read"), async (req, res) => {
    const projectId =
      (req.params as { projectId?: string; id?: string }).projectId ??
      (req.params as { id?: string }).id ??
      "";
    const input = await loadDetectorInput(projectId);
    const set = detectAgents({
      projectName: input.projectName,
      projectDescription: input.description,
      defaultModel: input.defaultModel,
      knownAgents: input.knownAgents,
      mcpServers: input.mcpServers,
    });
    const md = generateAgentsMd(set, {
      projectName: input.projectName,
      projectDescription: input.description,
    });
    res.type("text/markdown; charset=utf-8").send(md);
  });

  return r;
}
