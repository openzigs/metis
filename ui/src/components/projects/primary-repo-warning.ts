"use client";

/**
 * #428 / #448 — the one warning both project-create surfaces (the Create form
 * and the New-project wizard) show when `POST /projects` created the project but
 * did not link its repository.
 *
 * The description is the server's reason alone. The "Open Connections" action
 * is the hint, so the text does not append another "Add it from Connections."
 * — the server's generic reason already ends with one (#448).
 */
import { toast } from "sonner";
import type { CreatedProject } from "@/lib/projects-api";

/** It carries a reason and an action, so it outlasts sonner's ~4 s default. */
export const PRIMARY_REPO_WARNING_DURATION_MS = 10_000;

/** Used when the answer names no reason (a server from before #428). */
export const PRIMARY_REPO_NOT_LINKED_FALLBACK =
  "The repository could not be linked. Add it from the project's Connections page.";

export function warnPrimaryRepoNotLinked(
  project: CreatedProject,
  openConnections: (path: string) => void,
): void {
  toast.warning("Project created, but the repository was not linked", {
    description: project.primaryRepoError?.message ?? PRIMARY_REPO_NOT_LINKED_FALLBACK,
    duration: PRIMARY_REPO_WARNING_DURATION_MS,
    action: {
      label: "Open Connections",
      onClick: () => openConnections(`/projects/${project.id}/connections`),
    },
  });
}
