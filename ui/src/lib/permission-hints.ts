/**
 * Hints shown on a write control the viewer cannot use. The server gates the
 * write (#789, #1566); the control is disabled with this reason instead of
 * ending in a 403. One string, so every surface says the same thing (#1588).
 */
export const REQUIRES_PROJECT_UPDATE = "Requires project.update";
