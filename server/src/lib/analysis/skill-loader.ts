/**
 * Epic #515 / Issue #516 — Skill lazy-loading with trigger manifests.
 *
 * Provides two loading modes:
 * - "eager" (legacy): inject full skill instructions into the system prompt
 * - "lazy": inject only manifests (name: trigger | description) and provide
 *   an `expand_skill` tool that returns full instructions on demand
 *
 * Config: SKILL_LOADING=eager|lazy (default: lazy)
 */
import { createChildLogger } from "../logger.js";

const log = createChildLogger("skill-loader");

export type SkillLoadingMode = "eager" | "lazy";

export interface SkillManifestEntry {
  /** Unique skill key (used for lookup). */
  key: string;
  /** Human-readable name. */
  name: string;
  /** One-line trigger phrase. */
  trigger: string;
  /** One-line capability description. */
  description: string;
}

export interface SkillFullEntry extends SkillManifestEntry {
  /** Full instructions body. */
  instructions: string;
  /** Skill version string. */
  version: string;
}

/**
 * Get the configured skill loading mode from environment.
 */
export function getSkillLoadingMode(): SkillLoadingMode {
  const raw = process.env.SKILL_LOADING;
  if (raw === "eager") return "eager";
  return "lazy";
}

/**
 * Build the manifest line for a single skill.
 * Format: `skill_key: trigger_phrase | one-line capability description`
 */
export function buildManifestLine(entry: SkillManifestEntry): string {
  return `${entry.key}: ${entry.trigger} | ${entry.description}`;
}

/**
 * Build the full manifest block for all loaded skills.
 * Injected into the system prompt in lazy mode instead of full instructions.
 */
export function buildSkillManifestBlock(entries: SkillManifestEntry[]): string {
  if (entries.length === 0) return "";

  const lines = entries.map(buildManifestLine);
  return [
    "[Available Skills — call expand_skill to load full instructions]",
    ...lines,
    "",
    'To activate a skill, call: {"tool": "expand_skill", "args": {"skill": "<skill_key>"}}',
  ].join("\n");
}

/**
 * Build eager-mode full skill blocks (legacy behavior).
 */
export function buildEagerSkillBlocks(
  entries: SkillFullEntry[],
): Array<{ role: "system"; content: string }> {
  return entries.map((entry) => {
    const header = `[skill:${entry.key}@${entry.version}] ${entry.name}`;
    const desc = entry.description ? `\n${entry.description}` : "";
    const body = entry.instructions.trim();
    return {
      role: "system" as const,
      content: body.length === 0 ? `${header}${desc}` : `${header}${desc}\n\n${body}`,
    };
  });
}

/**
 * Registry for loaded skills that supports lazy expansion.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillFullEntry>();
  private readonly mode: SkillLoadingMode;

  constructor(mode?: SkillLoadingMode) {
    this.mode = mode ?? getSkillLoadingMode();
  }

  /** Register a skill into the registry. */
  register(entry: SkillFullEntry): void {
    this.skills.set(entry.key, entry);
  }

  /** Register multiple skills. */
  registerAll(entries: SkillFullEntry[]): void {
    for (const entry of entries) {
      this.register(entry);
    }
  }

  /** Get the current loading mode. */
  getMode(): SkillLoadingMode {
    return this.mode;
  }

  /** Get all registered manifests. */
  getManifests(): SkillManifestEntry[] {
    return Array.from(this.skills.values()).map(({ key, name, trigger, description }) => ({
      key,
      name,
      trigger,
      description,
    }));
  }

  /**
   * Expand a skill by key — returns the full instructions.
   * Returns null if the skill is not registered.
   */
  expandSkill(skillKey: string): string | null {
    const entry = this.skills.get(skillKey);
    if (!entry) {
      log.warn("Skill expansion requested for unknown skill", { skillKey });
      return null;
    }
    log.info("Expanding skill on-demand", { skillKey, mode: this.mode });
    return entry.instructions;
  }

  /**
   * Build system messages for the current mode.
   */
  buildSystemMessages(): Array<{ role: "system"; content: string }> {
    const entries = Array.from(this.skills.values());
    if (entries.length === 0) return [];

    if (this.mode === "eager") {
      return buildEagerSkillBlocks(entries);
    }

    // Lazy mode: single system message with manifest block
    const manifest = buildSkillManifestBlock(this.getManifests());
    return manifest.length > 0 ? [{ role: "system", content: manifest }] : [];
  }

  /** Check if a skill key exists. */
  has(skillKey: string): boolean {
    return this.skills.has(skillKey);
  }

  /** Get the count of registered skills. */
  get size(): number {
    return this.skills.size;
  }

  /** Clear all registered skills. */
  clear(): void {
    this.skills.clear();
  }
}

/**
 * Tool definition for `expand_skill` — registered in the agent loop when
 * lazy mode is active. Returns the full instructions for a named skill.
 */
export interface ExpandSkillArgs {
  skill: string;
}

/**
 * Create the expand_skill tool handler.
 */
export function createExpandSkillHandler(registry: SkillRegistry) {
  return (args: ExpandSkillArgs): { content: string; found: boolean } => {
    const instructions = registry.expandSkill(args.skill);
    if (instructions === null) {
      return {
        content: `Skill "${args.skill}" not found. Available skills: ${registry
          .getManifests()
          .map((m) => m.key)
          .join(", ")}`,
        found: false,
      };
    }
    return { content: instructions, found: true };
  };
}
