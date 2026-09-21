/**
 * Spec Kit Mode (Epic #193 — v1.2.0; Epic #396 — v1.3.0) — public surface.
 */
export {
  SpecKitArtifactError,
  isSpecKitEnabled,
  setSpecKitEnabled,
  listArtifacts,
  getArtifact,
  writeArtifact,
  deleteArtifact,
} from "./artifacts.js";
export { parseSpecKitCommand, COMMAND_OUTPUT, COMMAND_APPENDS } from "./parser.js";
export {
  generateConstitution,
  buildConstitution,
  defaultReader,
  readProjectConstitution,
  projectHasConstitution,
} from "./constitution.js";
export {
  validateConstitution,
  bumpSemver,
  detectBump,
  loadAsPreamble,
  upsertConstitution,
  getConstitutionMeta,
  REQUIRED_SECTIONS,
  REQUIRED_META,
} from "./constitution-meta.js";
export { runSpecify } from "./commands/specify.js";
export { runPlan } from "./commands/plan.js";
export { runTasks } from "./commands/tasks.js";
export { runClarify } from "./commands/clarify.js";
export { runAnalyze } from "./commands/analyze.js";
export { runImplement } from "./commands/implement.js";
export { runConstitution } from "./commands/constitution.js";
export {
  runChecklist,
  DEFAULT_CHECKLIST_DOMAINS,
  generateChecklist,
  mergeChecklists,
} from "./commands/checklist.js";
export { runPlanExpanded, ensureValidOpenAPI } from "./commands/plan-expanded.js";
export { runSpecifyFeature } from "./commands/specify-feature.js";
export { runTasksToIssues, renderIssueBody, noopIssueClient } from "./commands/taskstoissues.js";
export type {
  IssueClient,
  IssueCreateRequest,
  IssueCreatedResponse,
} from "./commands/taskstoissues.js";
export {
  createFeature,
  listFeatures,
  resolveFeatureBySlug,
  ensureLegacyFeature,
  nextSlugNumber,
  kebab,
  archiveFeature,
  restoreFeature,
  SpecKitFeatureLifecycleError,
  SPECKIT_FEATURE_ARCHIVED_STATUS,
  SPECKIT_FEATURE_SLUG_RE,
} from "./features.js";
export type { SpecKitFeatureDto, ListFeaturesOptions } from "./features.js";
export {
  getFeatureArtifact,
  listFeatureArtifacts,
  writeFeatureArtifact,
  deleteFeatureArtifact,
} from "./feature-artifacts.js";
export type { FeatureArtifactDto } from "./feature-artifacts.js";
export { computeStatus, requireGate, statusJsonBody, GateUnmetError } from "./gates.js";
export type { FeatureStatus, GateName } from "./gates.js";
export { parseTasksMarkdown } from "./tasks-parser.js";
export type { ParsedTask } from "./tasks-parser.js";
export {
  AC_ID_RE,
  SPEC_REQUIRED_SECTIONS,
  PLAN_REQUIRED_SECTIONS,
  extractHeadings,
  extractAcIds,
  extractSectionBody,
  parseAcceptanceCriteria,
  parseContractTasks,
  validateSpecContract,
  validatePlanContract,
  validateTasksContract,
} from "./artifact-contract.js";
export type {
  ParsedAcceptanceCriterion,
  ParsedContractTask,
  SpecContract,
  PlanContract,
  TasksContract,
} from "./artifact-contract.js";
export { runInstall, planInstall } from "./installer/index.js";
export type { InstallInput, InstallResult, InstallMode } from "./installer/index.js";
export { resolveAttached } from "./installer/path-guard.js";
export {
  HOSTS,
  isHostKey,
  emitHostFiles,
  buildPromptBody,
  CODEX_ALIAS_MAP,
  resolveCodexAlias,
  buildAgentsMdSection,
  mergeAgentsMd,
  emitCodexAgentsMd,
  AGENTS_MD_BEGIN,
  AGENTS_MD_END,
} from "./installer/hosts.js";
export type { HostKey } from "./installer/hosts.js";
export type { RunDeps, SpecKitProjectContext } from "./commands/runner.js";
