/**
 * Centralized TanStack Query keys. Co-locating keys here keeps invalidation
 * call-sites consistent across mutation handlers and prevents typos that
 * silently disable cache refresh.
 */
export const queryKeys = {
  auth: {
    all: ["auth"] as const,
    me: () => [...queryKeys.auth.all, "me"] as const,
  },
  projects: {
    all: ["projects"] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.projects.all, "list", filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.projects.all, "detail", id] as const,
    /** Epic #164 — usage rollup window. */
    usage: (id: string, window?: { from?: string; to?: string }) =>
      [...queryKeys.projects.all, "usage", id, window ?? {}] as const,
    safetyEvents: (id: string, filters?: Record<string, unknown>) =>
      [...queryKeys.projects.all, "safety-events", id, filters ?? {}] as const,
    /** Epic #193 — Spec Kit Mode artifacts. */
    specKitFiles: (id: string) => [...queryKeys.projects.all, "spec-kit", id, "files"] as const,
    specKitEnabled: (id: string) => [...queryKeys.projects.all, "spec-kit", id, "enabled"] as const,
    /** Epic #394 P2 (#404) — PR-review history per project. */
    prReviews: (id: string, filters?: Record<string, unknown>) =>
      [...queryKeys.projects.all, "pr-reviews", id, filters ?? {}] as const,
    /** Epic #394 P2 review #404 — single PR-review detail. */
    prReviewDetail: (id: string, prNumber: number, repo: { owner: string; name: string }) =>
      [
        ...queryKeys.projects.all,
        "pr-reviews",
        id,
        "detail",
        prNumber,
        repo.owner,
        repo.name,
      ] as const,
    /** Epic #852 (#858) — resolved database-aware-analysis state. */
    databaseAwareAnalysis: (id: string) =>
      [...queryKeys.projects.all, "database-aware-analysis", id] as const,
    /** Epic #882 (#894) — resolved sql-lineage state. */
    sqlLineage: (id: string) => [...queryKeys.projects.all, "sql-lineage", id] as const,
  },
  documents: {
    all: ["documents"] as const,
    forProject: (projectId: string) => [...queryKeys.documents.all, "project", projectId] as const,
  },
  analyses: {
    all: ["analyses"] as const,
    forProject: (projectId: string) => [...queryKeys.analyses.all, "project", projectId] as const,
    detail: (id: string) => [...queryKeys.analyses.all, "detail", id] as const,
    modelPreferences: (projectId: string) =>
      [...queryKeys.analyses.all, "model-preferences", projectId] as const,
    modelRecommendation: (projectId: string, override?: string) =>
      [...queryKeys.analyses.all, "model-recommendation", projectId, override ?? "auto"] as const,
  },
  issues: {
    all: ["issues"] as const,
    forProject: (projectId: string) => [...queryKeys.issues.all, "project", projectId] as const,
  },
  agents: {
    all: ["agents"] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.agents.all, "list", filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.agents.all, "detail", id] as const,
    versions: (id: string) => [...queryKeys.agents.all, "versions", id] as const,
  },
  skills: {
    all: ["skills"] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.skills.all, "list", filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.skills.all, "detail", id] as const,
    versions: (id: string) => [...queryKeys.skills.all, "versions", id] as const,
  },
  library: {
    all: ["library"] as const,
    search: (filters?: Record<string, unknown>) =>
      [...queryKeys.library.all, "search", filters ?? {}] as const,
    projectSkills: (projectId: string) =>
      [...queryKeys.library.all, "project", projectId, "skills"] as const,
    projectAvailableSkills: (projectId: string) =>
      [...queryKeys.library.all, "project", projectId, "skills", "available"] as const,
    projectAgents: (projectId: string) =>
      [...queryKeys.library.all, "project", projectId, "agents"] as const,
  },
  tasks: {
    all: ["tasks"] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.tasks.all, "list", filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.tasks.all, "detail", id] as const,
  },
  /** Epic #609 (#618) — formal review & approval workflow. */
  reviews: {
    all: ["reviews"] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.reviews.all, "list", filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.reviews.all, "detail", id] as const,
    /** Requirement version history feeding the review-item diff view (#770 API). */
    requirementHistory: (requirementId: string) =>
      [...queryKeys.reviews.all, "requirement-history", requirementId] as const,
  },
  /** Epic #609 (#620) — immutable requirement baselines (list, contents, compare). */
  baselines: {
    all: ["baselines"] as const,
    list: (projectId: string) => [...queryKeys.baselines.all, "list", projectId] as const,
    detail: (id: string) => [...queryKeys.baselines.all, "detail", id] as const,
    compare: (idA: string, idB: string) =>
      [...queryKeys.baselines.all, "compare", idA, idB] as const,
  },
  scheduler: {
    all: ["scheduler"] as const,
    jobs: (filters?: Record<string, unknown>) =>
      [...queryKeys.scheduler.all, "jobs", filters ?? {}] as const,
    job: (id: string) => [...queryKeys.scheduler.all, "job", id] as const,
    handlers: () => [...queryKeys.scheduler.all, "handlers"] as const,
    history: (id: string) => [...queryKeys.scheduler.all, "history", id] as const,
  },
  admin: {
    all: ["admin"] as const,
    users: () => [...queryKeys.admin.all, "users"] as const,
    audit: () => [...queryKeys.admin.all, "audit"] as const,
    mcp: () => [...queryKeys.admin.all, "mcp"] as const,
    mcpDetail: (id: string) => [...queryKeys.admin.all, "mcp", id] as const,
    /** Epic #930 — pluggable embeddings backends. */
    embeddings: () => [...queryKeys.admin.all, "embeddings"] as const,
    embeddingsCoverage: (projectId: string) =>
      [...queryKeys.admin.all, "embeddings", "coverage", projectId] as const,
  },
  eval: {
    all: ["eval"] as const,
    leaderboard: (bench?: string, days?: number) =>
      [...queryKeys.eval.all, "leaderboard", bench ?? "all", days ?? 30] as const,
    run: (id: string) => [...queryKeys.eval.all, "run", id] as const,
    domainRuns: (days?: number) => [...queryKeys.eval.all, "domain", "runs", days ?? 90] as const,
    domainRun: (id: string) => [...queryKeys.eval.all, "domain", "run", id] as const,
    onlineWindows: (days?: number) =>
      [...queryKeys.eval.all, "online", "windows", days ?? 90] as const,
    onlineStatus: () => [...queryKeys.eval.all, "online", "status"] as const,
  },
  products: {
    all: ["products"] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.products.all, "list", filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.products.all, "detail", id] as const,
    documents: (id: string, docType?: string) =>
      [...queryKeys.products.all, "documents", id, docType ?? "all"] as const,
    analyses: (id: string) => [...queryKeys.products.all, "analyses", id] as const,
    repoConnections: (search?: string) =>
      [...queryKeys.products.all, "repo-connections", search ?? ""] as const,
  },
  jira: {
    all: ["jira"] as const,
    connections: (projectId: string) => [...queryKeys.jira.all, "connections", projectId] as const,
    connectionDetail: (id: string) => [...queryKeys.jira.all, "connection", id] as const,
    projects: (connectionId: string) => [...queryKeys.jira.all, "projects", connectionId] as const,
    search: (connectionId: string, jql: string, startAt?: number) =>
      [...queryKeys.jira.all, "search", connectionId, jql, startAt ?? 0] as const,
    issue: (connectionId: string, key: string) =>
      [...queryKeys.jira.all, "issue", connectionId, key] as const,
  },
  imports: {
    all: ["imports"] as const,
    sources: (projectId: string) => [...queryKeys.imports.all, "sources", projectId] as const,
    source: (projectId: string, id: string) =>
      [...queryKeys.imports.all, "source", projectId, id] as const,
    runs: (projectId: string, sourceId?: string) =>
      [...queryKeys.imports.all, "runs", projectId, sourceId ?? "all"] as const,
  },
  changeAnalysis: {
    all: ["changeAnalysis"] as const,
    forProject: (projectId: string) =>
      [...queryKeys.changeAnalysis.all, "project", projectId] as const,
    detail: (projectId: string, id: string) =>
      [...queryKeys.changeAnalysis.all, "detail", projectId, id] as const,
  },
  publishDestination: {
    all: ["publishDestination"] as const,
    forProject: (projectId: string) =>
      [...queryKeys.publishDestination.all, "project", projectId] as const,
  },
  templates: {
    all: ["templates"] as const,
    forProject: (projectId: string) => [...queryKeys.templates.all, "project", projectId] as const,
    detail: (projectId: string, id: string) =>
      [...queryKeys.templates.all, "detail", projectId, id] as const,
  },
  /** Epic #728 — Collaboration (comments, assignments). */
  comments: {
    all: ["comments"] as const,
    forRequirement: (requirementId: string) =>
      [...queryKeys.comments.all, "requirement", requirementId] as const,
    forArtifact: (projectId: string, artifactName: string) =>
      [...queryKeys.comments.all, "artifact", projectId, artifactName] as const,
  },
  assignments: {
    all: ["assignments"] as const,
    forRequirement: (requirementId: string) =>
      [...queryKeys.assignments.all, requirementId] as const,
  },
} as const;

export type QueryKeys = typeof queryKeys;
