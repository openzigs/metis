/**
 * Hints shown on a write control the viewer cannot use. The server gates the
 * write (#789, #1566); the control is disabled with this reason instead of
 * ending in a 403. One string, so every surface says the same thing (#1588).
 */
export const REQUIRES_PROJECT_UPDATE = "Requires project.update";

/**
 * #2436 — a requirement's verdict (Approve, Reject) is a `requirement.approve`
 * write server-side, separate from editing it (`project.update`).
 */
export const REQUIRES_REQUIREMENT_APPROVE = "Requires requirement.approve";

/**
 * #1591 — a requirement's data mappings (add, remove, suggest, accept) are
 * `connector.write` writes server-side (`server/src/routes/data-mappings.ts`),
 * not `project.update` ones: a developer holds neither.
 */
export const REQUIRES_CONNECTOR_WRITE = "Requires connector.write";

/**
 * #2450 — starting a change request (`POST /api/projects/:id/analyses`) is an
 * `analysis.run` write. A viewer without it is told why there is no form,
 * rather than being offered one that ends in a 403.
 */
export const START_CHANGE_REQUEST_HINT =
  "Starting a change request needs the analysis.run permission (developer, coordinator or admin by default). You can still read this project's change requests.";
