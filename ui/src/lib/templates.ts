/**
 * Phase 12 — localStorage-backed prompt template store (issue #85).
 *
 * Templates support `{{var}}` substitution. Variables are auto-discovered
 * from the body. Required vs optional is declared per template; missing
 * required vars block the run.
 *
 * Stored client-side (per-user, per-browser) on purpose — the AC scopes
 * this to the analyst's working surface, not a shared catalogue. A future
 * phase can promote a template to the server-backed Library if desired.
 */

const STORAGE_KEY = "metis.library.templates";

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  body: string;
  /** Variable names that must be filled before running. Subset of detected vars. */
  required: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TemplateRunPayload {
  prompt: string;
  templateId: string;
  templateName: string;
}

const VAR_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** All `{{var}}` names referenced in `body`, deduplicated, in order. */
export function extractVariables(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(VAR_PATTERN)) {
    const name = m[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Substitute `{{var}}` placeholders. Throws if any required variable is
 * missing or blank — callers should surface the error to the user instead
 * of running with a half-filled prompt.
 */
export function substitute(
  body: string,
  values: Record<string, string>,
  required: string[],
): string {
  const missing = required.filter((k) => {
    const v = values[k];
    return typeof v !== "string" || v.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`Missing required variables: ${missing.join(", ")}`);
  }
  return body.replace(VAR_PATTERN, (_match, name: string) => values[name] ?? "");
}

function readAll(): PromptTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is PromptTemplate => {
        if (typeof t !== "object" || t === null) return false;
        const r = t as Partial<PromptTemplate>;
        return (
          typeof r.id === "string" &&
          typeof r.name === "string" &&
          typeof r.body === "string" &&
          Array.isArray(r.required)
        );
      })
      .map((t) => ({
        ...t,
        description: typeof t.description === "string" ? t.description : "",
      }));
  } catch {
    return [];
  }
}

function writeAll(templates: PromptTemplate[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {
    /* quota or private-mode — silently drop */
  }
}

export const templatesStore = {
  list(): PromptTemplate[] {
    return readAll();
  },
  get(id: string): PromptTemplate | undefined {
    return readAll().find((t) => t.id === id);
  },
  create(input: {
    name: string;
    description?: string;
    body: string;
    required?: string[];
  }): PromptTemplate {
    const now = new Date().toISOString();
    const detected = extractVariables(input.body);
    const required = (input.required ?? []).filter((k) => detected.includes(k));
    const t: PromptTemplate = {
      id: `tpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      name: input.name,
      description: input.description ?? "",
      body: input.body,
      required,
      createdAt: now,
      updatedAt: now,
    };
    const all = readAll();
    all.unshift(t);
    writeAll(all);
    return t;
  },
  update(
    id: string,
    patch: Partial<Omit<PromptTemplate, "id" | "createdAt">>,
  ): PromptTemplate | undefined {
    const all = readAll();
    const idx = all.findIndex((t) => t.id === id);
    if (idx === -1) return undefined;
    const current = all[idx]!;
    const next: PromptTemplate = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (patch.body !== undefined) {
      const detected = extractVariables(patch.body);
      next.required = (patch.required ?? next.required).filter((k) => detected.includes(k));
    }
    all[idx] = next;
    writeAll(all);
    return next;
  },
  remove(id: string): boolean {
    const all = readAll();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) return false;
    writeAll(next);
    return true;
  },
  clear(): void {
    writeAll([]);
  },
};

const PENDING_KEY = "metis.library.pendingRun";

/**
 * Hand-off from Library → Chat. The Chat page reads + clears this on mount
 * to seed the input field with the substituted prompt.
 */
export function stashRunPayload(payload: TemplateRunPayload): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(payload));
  } catch {
    /* swallow */
  }
}

export function consumeRunPayload(): TemplateRunPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(PENDING_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Partial<TemplateRunPayload>;
    if (typeof obj.prompt !== "string" || typeof obj.templateId !== "string") return null;
    return {
      prompt: obj.prompt,
      templateId: obj.templateId,
      templateName: typeof obj.templateName === "string" ? obj.templateName : "",
    };
  } catch {
    return null;
  }
}
