/**
 * #945 — what the Spec Kit page shows a person, as opposed to what the API
 * returns: artifact text without its machine markers, errors in the page's own
 * words, and the `/speckit.implement` handoff kept across navigation.
 */
import { ApiError } from "@/lib/api-client";

/** The checklist's hidden record of the checks it generated (base64 JSON, #787). */
const GENERATED_CHECKS_MARKER = "<!-- speckit-generated-checks:";

/**
 * The artifact text to display: lines that only carry a machine marker are
 * dropped. The stored artifact (and the editor) keep them — the next
 * `/speckit.checklist` run reads the marker to merge a person's edits.
 */
export function displayArtifactText(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(GENERATED_CHECKS_MARKER))
    .join("\n");
}

/** Markdown artifacts are rendered; anything else (the OpenAPI YAML) is shown as wrapped text. */
export function isMarkdownArtifact(key: string): boolean {
  return key.toLowerCase().endsWith(".md");
}

/** The artifact each phase gate is waiting for, and the command that writes it. */
const GATE_TEXT: Record<string, string> = {
  specGate: "This feature has no spec.md yet. Run /speckit.specify first.",
  planGate: "This feature has no plan.md yet. Run /speckit.plan on it first.",
  tasksGate: "This feature has no tasks.md yet. Run /speckit.tasks on it first.",
  implementGate: "This feature has no tasks.md yet. Run /speckit.tasks on it first.",
};

/** Server codes whose message names API fields or legacy command names. */
const CODE_TEXT: Record<string, string> = {
  SPEC_KIT_PLAN_NEEDS_SPEC: "There is no spec.md yet. Run /speckit.specify first.",
  SPEC_KIT_ANALYZE_INCOMPLETE:
    "/speckit.analyze needs spec.md, plan.md and tasks.md. Run /speckit.specify, /speckit.plan and /speckit.tasks first.",
};

interface ValidationIssue {
  path?: unknown;
  message?: unknown;
}

/**
 * A 400 whose message is a serialized validation-issue array (the server
 * forwards Zod's `error.message`), as one readable sentence. `null` when the
 * message is not one.
 */
function describeValidationIssues(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("[")) return null;
  let issues: unknown;
  try {
    issues = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const parts = (issues as ValidationIssue[]).map((issue) => {
    const text = typeof issue.message === "string" ? issue.message : "is not valid";
    const path = Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
    return path ? `${path}: ${text}` : text;
  });
  return `The request was not accepted — ${parts.join("; ")}.`;
}

/** The error text the page shows for a failed Spec Kit call. */
export function describeSpecKitError(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return "The Spec Kit operation failed. Please try again.";
  }
  if (err.code === "SPECKIT_GATE_UNMET") {
    const details = err.details as { required?: unknown } | undefined;
    const required = typeof details?.required === "string" ? details.required : "";
    if (GATE_TEXT[required]) return GATE_TEXT[required]!;
  }
  if (err.code && CODE_TEXT[err.code]) return CODE_TEXT[err.code]!;
  if (err.status === 400) {
    const issues = describeValidationIssues(err.message);
    if (issues) return issues;
  }
  return err.message;
}

/** True when the project is missing or the viewer is not a member of its workspace. */
export function isNoProjectAccess(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 403);
}

/** What `/speckit.implement` handed off, for "Start analysis with these artifacts". */
export interface SpecKitHandoff {
  context: string[];
  feature: string | null;
}

const handoffKey = (projectId: string): string => `metis:spec-kit-handoff:${projectId}`;

/** The project's pending handoff from this browser tab's session, or null. */
export function loadHandoff(projectId: string): SpecKitHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(handoffKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SpecKitHandoff>;
    if (!Array.isArray(parsed.context) || !parsed.context.every((c) => typeof c === "string")) {
      return null;
    }
    const feature = typeof parsed.feature === "string" ? parsed.feature : null;
    return { context: parsed.context, feature };
  } catch {
    return null;
  }
}

/** Keep (or, with null, forget) the project's pending handoff for this tab's session. */
export function saveHandoff(projectId: string, handoff: SpecKitHandoff | null): void {
  if (typeof window === "undefined") return;
  try {
    if (handoff) window.sessionStorage.setItem(handoffKey(projectId), JSON.stringify(handoff));
    else window.sessionStorage.removeItem(handoffKey(projectId));
  } catch {
    // Storage full or blocked: the card still works for this page view.
  }
}
