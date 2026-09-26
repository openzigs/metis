/**
 * HTTP + Socket.IO bootstrap. `createServer()` returns the wired-up server but
 * does NOT call `listen()` — callers (production entrypoint, tests) decide
 * when to start accepting connections.
 */
import http from "node:http";
import { createApp, type CreateAppOptions } from "./app.js";
import { bootstrapMCP, type MCPBootstrap } from "./lib/mcp/index.js";
import { createSocketServer, type MetisIOServer } from "./lib/socket/server.js";
import { AnalysisOrchestrator, setOrchestratorForTests } from "./lib/analysis/index.js";
import { buildProvider, loadAIConfig, maybeWrapProviderForFixtures } from "./lib/ai/index.js";
import { BedrockDirectProvider } from "./lib/ai/providers/bedrock-direct-provider.js";
import { configureDbConnectorService } from "./lib/connectors/db/db-service.js";
import { configureRepoConnectorService } from "./lib/connectors/repo/repo-service.js";
import { createSocketConnectorEmitter } from "./lib/connectors/socket-emitter.js";
import { configurePublisher } from "./lib/publishing/publisher.js";
import { createSocketPublishEmitter } from "./lib/publishing/socket-emitter.js";
import { configureKnowledgeService } from "./lib/rag/knowledge-service.js";
import { configureIngestQueue, getIngestQueue } from "./lib/rag/ingest-queue.js";
import { createSocketDocumentEmitter } from "./lib/rag/socket-emitter.js";
import { configureTestCoverageRuntime } from "./lib/testcoverage/task-runner.js";
import { createProviderJudgeCaller } from "./lib/testcoverage/judge-caller.js";
import { createSocketTestCoverageEmitter } from "./lib/testcoverage/socket-emitter.js";
import { setUsageEmitter } from "./lib/finops/index.js";
import { autoDiscoverFromWorkspace } from "./lib/library/index.js";
import { bootstrapScheduler, subscribeSchedulerToConfig } from "./lib/scheduler/index.js";
import { resolveLeaderElection, type LeaderElector } from "./lib/scheduler/leader-election.js";
import type { SchedulerBootstrap } from "./lib/scheduler/index.js";
import { buildSchedulerHandlerOverrides } from "./lib/scheduler/handler-overrides.js";
import { registerImportTaskHandlers } from "./lib/importers/import-task.js";
import { getImportService } from "./lib/importers/import-service.js";
import { subscribeAllowlistToConfig } from "./lib/connectors/network-allowlist.js";
import { installBuiltinHandlers } from "./lib/hooks/builtin-handlers.js";
import { startRevocationPruner } from "./lib/auth/revocation-store.js";
import { registerPostgresRateLimitStore } from "./lib/discussions/rate-limit-store-postgres.js";
import { registerPostgresSSOStateStore } from "./lib/auth/sso-state-store-postgres.js";
import { registerPostgresSamlRequestIdCache } from "./lib/auth/saml-request-id-cache-postgres.js";
import { registerS3Storage } from "./lib/documents/storage-backend-s3.js";
import { registerPgVectorStore } from "./lib/rag/vector-store-pgvector.js";
import { ensureBuiltInAgents } from "./lib/custom-agents/index.js";
import { configureAsyncRunner, type RunnerEmitter } from "./lib/async/runner.js";
import { registerBuiltinRunHandlers } from "./lib/async/handlers.js";
import { attachAcpServer, type AcpServerHandle } from "./lib/acp/server.js";
import { getToolRegistry } from "./lib/ai/tool-registry.js";
import { registerApplyDiff } from "./lib/ai/tools/apply-diff.js";
import { registerScoreGrounding } from "./lib/ai/tools/score-grounding.js";
import { registerInspectSchema } from "./lib/ai/tools/inspect-schema.js";
import { registerQueryDatabase } from "./lib/ai/tools/query-database.js";
import { registerSearchKnowledgeGlobalTool } from "./lib/rag/search-knowledge-global-tool.js";
import { registerSearchKnowledgeTool } from "./lib/rag/search-knowledge-tool.js";
import { createChildLogger } from "./lib/logger.js";
import { getConfigService } from "./lib/config/config-service.js";
import {
  startWorker,
  type PrReviewProcessorDeps,
  type PrReviewWorkerHandle,
} from "./lib/agents/pr-reviewer/worker.js";
import { setPrReviewWorker } from "./lib/agents/pr-reviewer/worker-singleton.js";
import { findProjectForRepo } from "./routes/webhooks-github.js";
import { registerSocketServer } from "./lib/socket/registry.js";
import { wirePresenceHandlers } from "./lib/collaboration/presence.js";
import { startSlaChecker } from "./lib/collaboration/sla-checker.js";
import { startForecastRecompute } from "./lib/finops/forecast-service.js";
import { startAlertEngine, setDefaultDispatcherFactory } from "./lib/finops/alert-engine.js";
import { createDispatcher } from "./lib/finops/channels/dispatcher.js";
import { startChargebackScheduler } from "./lib/finops/chargeback-scheduler.js";
import { startWorkspaceUsageRollup } from "./lib/workspaces/usage-rollup.js";
import { startInterruptedGenerationSweeper } from "./lib/docs-gen/interrupted-generations.js";
import { reconcileStrandedGeneratedDocPublications } from "./lib/docs-gen/generated-doc-publication-recovery.js";

const log = createChildLogger("server-bootstrap");

/**
 * Epic #518 (#544) — the leader elector for this process. Module-scoped so a
 * future graceful-shutdown path can `await leaderElector?.stop()` to release the
 * lease promptly (a survivor then takes over without waiting for the TTL). Unset
 * in tests and in the always-leader single-replica path until `createServer`
 * wires it.
 */
let leaderElector: LeaderElector | undefined;

/** Expose the active leader elector (diagnostics / graceful shutdown). */
export function getLeaderElector(): LeaderElector | undefined {
  return leaderElector;
}

/**
 * Epic #518 (#544) — the set of CLUSTER-SINGLETON background jobs, started only
 * on the leader and stopped when leadership is lost. Each job already exposes a
 * `start*()` returning a `{ stop() }` handle (the established FinOps / revocation
 * lifecycle pattern); we just gate when they run. `start()`/`stop()` are
 * idempotent so repeated leadership transitions never double-register a timer or
 * leak a handle.
 *
 * Exported for `tests/singleton-jobs-wiring.test.ts` (#1303) only — nothing else
 * constructs it. Whether a job is in this list is the difference between it
 * running and it being dead code that still has a passing unit test, which is
 * exactly how the workspace usage rollup sat unreferenced from #763 to #1303, so
 * the membership is worth pinning with a test rather than a comment.
 */
export class SingletonJobs {
  private handles: Array<{ stop(): void }> = [];
  private running = false;

  constructor(private readonly sched: SchedulerBootstrap) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info("starting cluster-singleton scheduler + background jobs (leader)");
    // Central scheduler cron registration (DB-backed ScheduledJobs).
    this.sched.scheduler
      .start()
      // #189 — AFTER durable task recovery has re-queued live publication tasks,
      // settle any generated-doc synthetic row that no task will ever finish.
      .then(() => reconcileStrandedGeneratedDocPublications())
      .catch((err) => {
        log.warn("Scheduler start failed", { error: (err as Error).message });
      });
    // Scattered interval jobs — each fires once cluster-wide now they run only
    // on the leader. Epic refs: #736 (SLA), #48/#49/#52 (FinOps), #413 (revocation).
    this.handles = [
      startSlaChecker(),
      // #1303 — the only writer of `workspace_usage_daily`, which
      // startForecastRecompute() below reads. It was registered nowhere until
      // #1303, so every workspace-scope forecast was computed over an all-zero
      // window. Array position carries no happens-before (both calls only arm
      // a timer); the pairing is a data dependency, and the rollup's own
      // catch-up on first run is what makes the table readable.
      startWorkspaceUsageRollup(),
      startForecastRecompute(),
      startAlertEngine(),
      startChargebackScheduler(),
      startRevocationPruner(),
    ];
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    log.info("stopping cluster-singleton scheduler + background jobs (leadership lost)");
    void this.sched.scheduler.stop().catch((err) => {
      log.warn("Scheduler stop failed", { error: (err as Error).message });
    });
    for (const h of this.handles) {
      try {
        h.stop();
      } catch (err) {
        log.warn("singleton job stop failed", { error: (err as Error).message });
      }
    }
    this.handles = [];
  }
}

export interface MetisServer {
  http: http.Server;
  io: MetisIOServer;
  mcp: MCPBootstrap;
  acp: AcpServerHandle;
  /**
   * Epic #394 P2 review F4 — PR-reviewer worker handle. Always present
   * (even in tests, where it runs with a no-op processor) so graceful
   * shutdown can call `prReviewWorker.shutdown()` unconditionally.
   */
  prReviewWorker: PrReviewWorkerHandle;
}

export interface CreateServerOptions extends CreateAppOptions {
  /** Skip MCP health-monitor + lifecycle bootstrap (used by tests). */
  skipMCPBootstrap?: boolean;
  /**
   * Epic #394 P2 review (post-`e7eb006`) — wire the real PR-review
   * processor. When supplied, the worker resolves judge + octokit per
   * job and calls the agent entrypoint instead of logging a warn.
   * Tests inject mocks here; production deploys would supply factories
   * sourced from env / vault.
   */
  prReviewProcessorDeps?: Partial<PrReviewProcessorDeps>;
}

export function createServer(opts: CreateServerOptions = {}): MetisServer {
  // #60 — the shared-backend factories are registered BEFORE `createApp()`, because
  // building the routers resolves some of these backends: `documentsRouter` builds
  // the KnowledgeService, whose constructor calls `getVectorStore()`. Registered
  // after it (as they were), `VECTOR_STORE=pgvector` — the production Helm setting —
  // threw "the pgvector store factory was not registered" and the server exited
  // before listening. No unit test could see it (they run under NODE_ENV=test,
  // where this block is skipped); the image smoke's Postgres arm, which runs
  // production's backends, did.
  if (process.env.NODE_ENV !== "test") {
    // Epic #518 (#541) — wire the shared Postgres-backed rate-limit store factory
    // so `DISCUSSION_RATE_LIMIT_BACKEND=postgres` enforces the discussion
    // AI-invocation cap cluster-wide across replicas. Registering the factory is
    // cheap and side-effect-free; the store is only built (and Postgres only
    // touched) if that backend is actually selected.
    registerPostgresRateLimitStore();

    // Epic #518 (#542) — wire the shared Postgres-backed SSO transaction-state
    // store factory so `SSO_STATE_BACKEND=postgres` makes the OIDC/SAML
    // initiate->callback handshake survive load balancing across replicas. Like
    // the rate-limit factory above, registering is cheap and side-effect-free;
    // the store is only built (and Postgres only touched) if that backend is
    // selected.
    registerPostgresSSOStateStore();

    // Epic #517 (#520) — wire the shared Postgres-backed SAML request-id cache
    // factory so `SAML_REQUEST_ID_CACHE_BACKEND=postgres` makes SAML
    // `validateInResponseTo` replay protection work cluster-wide: the request id
    // minted on the AuthnRequest pod is visible on the (possibly different)
    // Response/ACS pod. Like the factories above, registering is cheap and
    // side-effect-free; the cache is only built (and Postgres only touched) if
    // that backend is actually selected.
    registerPostgresSamlRequestIdCache();

    // Epic #518 (#543) — wire the shared pgvector store factory so
    // `VECTOR_STORE=pgvector` makes the RAG vector store multi-replica safe
    // (every replica reads/writes the same vectors in Postgres instead of a
    // per-pod LanceDB dir that concurrent writers corrupt). Like the factories
    // above, registering is cheap and side-effect-free; the store is only built
    // (and Postgres only touched) if that backend is actually selected.
    registerPgVectorStore();

    // Epic #518 (#546) — wire the S3 uploads-storage factory so
    // `UPLOAD_STORAGE_BACKEND=s3` writes uploaded document blobs to an object
    // store instead of a per-pod RWO PVC. That makes uploads multi-replica safe
    // (any replica reads what any other wrote) — the last per-pod-locality
    // blocker to lifting `replicaCount=1`. Like the factories above, registering
    // is cheap and side-effect-free; the S3 client is only constructed (and the
    // bucket config only read) if that backend is actually selected.
    registerS3Storage();
  }

  // NOTE: the embedding env (EMBED_POOLING_MAP / EMBED_POOLING / EMBED_DTYPE) is
  // validated at boot inside `createApp()` (issue #782) — the same call below.
  const app = createApp(opts);
  const httpServer = http.createServer(app);
  const io = createSocketServer(httpServer, opts);
  // Epic #728 — register IO in the global registry so lib code (e.g.
  // @mention fan-out, presence) can access it without DI threading.
  registerSocketServer(io);
  wirePresenceHandlers(io);
  // Issue #251 — preload vault-backed runtime secrets into ConfigService so
  // synchronous `get(key)` calls in provider factories see vault values
  // ahead of env on the very first request. Failures are non-fatal: callers
  // fall back to env, which preserves prior behaviour.
  if (process.env.NODE_ENV !== "test") {
    const cfg = getConfigService();
    cfg.loadSecrets().catch((err) => {
      log.warn("ConfigService.loadSecrets failed at boot", {
        error: (err as Error).message,
      });
    });
    // Issue #255 \u2014 also preload Tier-3 tunables from runtime_config so
    // synchronous `get(key)` calls during the first request observe DB
    // overrides instead of falling through to env.
    cfg.loadTunables().catch((err) => {
      log.warn("ConfigService.loadTunables failed at boot", {
        error: (err as Error).message,
      });
    });
  }
  // Wire the analysis orchestrator with the live io reference so
  // analysis:agent events broadcast into the analysis:{id} rooms.
  let aiProvider: import("./lib/ai/types.js").AIProvider | undefined;
  try {
    const config = loadAIConfig();
    if (
      (config.provider === "bedrock-gateway" || config.provider === "local-gemma") &&
      config.sdkProvider
    ) {
      aiProvider = maybeWrapProviderForFixtures(
        new BedrockDirectProvider({
          baseUrl: config.sdkProvider.baseUrl,
          apiKey: config.sdkProvider.apiKey ?? "",
          model: config.model,
          providerKey: config.provider,
          modelProfileMap: config.modelProfileMap,
        }),
      );
    } else {
      aiProvider = buildProvider({ config });
    }
    setOrchestratorForTests(new AnalysisOrchestrator({ provider: aiProvider, io }));
  } catch {
    // Provider construction failure (missing creds in dev) is non-fatal \u2014
    // the route handler will lazy-init with a stub on first request.
  }
  const mcp = bootstrapMCP({
    io,
    startHealthMonitor: !opts.skipMCPBootstrap,
  });
  // Phase 8 — wire connector services with the live io reference so progress
  // events broadcast into the connector:{id} rooms.
  const connectorEmitter = createSocketConnectorEmitter(io);
  configureDbConnectorService({ emitter: connectorEmitter });
  configureRepoConnectorService({ emitter: connectorEmitter });
  // Phase 9 — wire publish emitter so live publish events broadcast into
  // the `publish:{batchId}` rooms.
  configurePublisher({ emitter: createSocketPublishEmitter(io) });

  // v1.0.1 issue #133 — wire the realtime document emitter and rebuild the
  // KnowledgeService + IngestQueue singletons so live ingest progress
  // broadcasts into `project:{projectId}` rooms instead of being dropped.
  const documentEmitter = createSocketDocumentEmitter(io);
  configureKnowledgeService({ emit: documentEmitter });
  configureIngestQueue({ emit: documentEmitter });
  // Touch the singleton so any environment validation runs at boot, not on
  // first upload.
  getIngestQueue();

  // Epic #880 issue #886 — wire the test-coverage runner with a live LLM
  // caller + socket emitter so the judge + suggestion phases actually run in
  // production. Without a caller the runner silently skips those phases
  // (the original #886 bug). When the provider could not be built (missing
  // creds in dev), only the emitter is wired so progress events still flow.
  configureTestCoverageRuntime({
    emitter: createSocketTestCoverageEmitter(io),
    ...(aiProvider ? { caller: createProviderJudgeCaller(aiProvider) } : {}),
  });

  // Epic #164 — wire the FinOps usage emitter so `recordUsage` ticks fan
  // out to the `project:{id}` Socket.IO room and the UI usage page can
  // re-render without polling.
  setUsageEmitter((projectId, payload) => {
    io.to(`project:${projectId}`).emit("usage:tick", payload);
  });

  // Phase 11 — bootstrap scheduler + task queue. Cron registration is
  // started asynchronously; failures are non-fatal so the API stays up.
  // Issue #260 — wire the scheduler runtime-config subscriber so admin
  // changes to SCHEDULER_ENABLED / SCHEDULER_TICK_INTERVAL_MS take effect
  // without restarting the server.
  if (process.env.NODE_ENV !== "test") {
    const sched = bootstrapScheduler({ io, handlerOverrides: buildSchedulerHandlerOverrides() });
    // Epic #776 — register the inbound-importer task handler BEFORE any
    // scheduled job is created so the registry can validate the task type.
    // Handler registration + the runtime-config subscriber are PER-POD (every
    // replica must be able to validate task types and serve the scheduler API /
    // manual run-now); only the cron *firing* is leader-gated below.
    registerImportTaskHandlers(sched.registry, {
      runSource: (importSourceId, opts) => getImportService().runSource(importSourceId, opts),
    });
    subscribeSchedulerToConfig(sched);

    // Epic #518 (#544) — distributed leader election. The in-process scheduler
    // cron AND the scattered interval jobs (SLA checker, FinOps forecast / alert
    // engine / chargeback, refresh-token revocation pruner) are CLUSTER
    // SINGLETONS: with `N` replicas each would otherwise fire `N` times per due
    // instant. We start them ONLY while this pod holds the `scheduler` lease, and
    // stop them the moment it loses it (crash failover hands the lease to a
    // survivor, which then starts them). Per-pod housekeeping (Socket.IO
    // ping/pong, per-MCP-server health probes) is intentionally NOT gated.
    //
    // Default / single-replica & SQLite deployments: `resolveLeaderElection`
    // returns an always-leader, so behaviour is unchanged from today. Production
    // multi-replica opts in via `SCHEDULER_LEADER_ELECTION=postgres` with a
    // Postgres `DATABASE_URL` (see docs/EKS_DEPLOYMENT.md).
    setDefaultDispatcherFactory(() => createDispatcher());
    const singletons = new SingletonJobs(sched);
    const elector = resolveLeaderElection({
      ...process.env,
      onChange: (isLeader) => {
        if (isLeader) singletons.start();
        else singletons.stop();
      },
    });
    leaderElector = elector;
    elector.start().catch((err) => {
      log.warn("Leader election start failed", { error: (err as Error).message });
    });
  }

  // Issue #262 — wire the SSRF allow-list cache to the runtime-config event
  // bus so DB_ALLOWED_HOSTS / REPO_ALLOWED_HOSTS / PUBLISH_GITHUB_ALLOWED_HOSTS
  // changes invalidate the in-process compiled set immediately. PER-POD — each
  // replica maintains its own compiled allow-list cache.
  if (process.env.NODE_ENV !== "test") {
    subscribeAllowlistToConfig();
  }

  // Phase 10 \u2014 optional auto-discovery of skills + agents from the running
  // workspace. Best-effort \u2014 failures audit but never block boot. Disabled
  // when LIBRARY_AUTO_DISCOVER_ROOT is unset (i.e. tests + production).
  const discoverRoot = process.env.LIBRARY_AUTO_DISCOVER_ROOT;
  if (discoverRoot && process.env.NODE_ENV !== "test") {
    autoDiscoverFromWorkspace(discoverRoot, { id: "system" }).catch((err) => {
      log.warn("Library auto-discover failed", { error: (err as Error).message });
    });
  }

  // Epic #165 \u2014 install built-in lifecycle hook handlers and seed the
  // built-in custom-agent fleet (BA / Architect / PO / QA). Both are
  // idempotent and best-effort.
  installBuiltinHandlers();
  if (process.env.NODE_ENV !== "test") {
    ensureBuiltInAgents().catch((err) => {
      log.warn("Built-in custom agent seed failed", { error: (err as Error).message });
    });
    // Epic #404 (#413) — prune expired refresh-token revocation rows so the
    // persistent revocation table stays bounded. Epic #518 (#544): this is a
    // cluster singleton, now started only on the leader (see SingletonJobs).
  }

  // Epic #156 \u2014 wire the async background runner with a socket emitter so
  // bg-run:status / bg-run:step events broadcast into project rooms.
  const bgEmitter: RunnerEmitter = {
    status: (run) => {
      io.to(`project:${run.projectId}`).emit("bg-run:status", {
        ...run,
        ts: Date.now(),
      });
    },
    step: (e) => {
      io.to(`run:${e.runId}`).emit("bg-run:step", e);
    },
  };
  const runner = configureAsyncRunner({ emitter: bgEmitter });
  registerBuiltinRunHandlers(runner);
  // Epic #195 — register the morph-apply diff editor as a regular AI tool.
  // Idempotent so test reloads don't crash the registry.
  registerApplyDiff(getToolRegistry());
  // Epic #194 — `score_grounding` (read-only judge tool).
  registerScoreGrounding(getToolRegistry());
  // Epic #880 issue #881 — `inspect_schema` (project-scoped DB schema tool).
  registerInspectSchema(getToolRegistry());
  // Epic #880 issue #887 — `query_database` (project-scoped SELECT-only tool).
  registerQueryDatabase(getToolRegistry());
  // Epic #526 — cross-project federated search tool.
  registerSearchKnowledgeGlobalTool();
  // Issue #43 — project-scoped knowledge search tool.
  registerSearchKnowledgeTool();
  if (process.env.NODE_ENV !== "test") {
    runner
      .recoverStaleRuns()
      .then(() => runner.dispatchQueued())
      .catch((err) => log.warn("Async runner recover failed", { error: (err as Error).message }));
    // #50 — documentation generation runs in-process, so a restart orphans it.
    // Fail any whose heartbeat stopped (now, then every minute) instead of
    // leaving it `generating` forever.
    startInterruptedGenerationSweeper();
  }

  // Epic #163, Issue #119 — attach the ACP WebSocket server. Disabled in
  // tests by default (set ACP_ENABLED=1 to opt in for an integration test).
  const acp: AcpServerHandle =
    process.env.NODE_ENV === "test" && process.env.ACP_ENABLED !== "1"
      ? createNoopAcpHandle()
      : attachAcpServer(httpServer);

  // Epic #394 P2 review F4 + post-`e7eb006` follow-up — start the
  // PR-reviewer worker. The processor now wires the *real* agent
  // entrypoint via `processorDeps`: every job resolves the project +
  // judge + octokit and invokes `executePrReviewJob`. When the optional
  // `judge` / `octokit` resolvers are not supplied (current default —
  // production credential wiring is tracked separately), the processor
  // logs a structured `pr_review.deps_unresolved` per job instead of
  // silently dropping it. Tests can override individual resolvers via
  // `opts.prReviewProcessorDeps`.
  const userDeps = opts.prReviewProcessorDeps ?? {};
  const processorDeps: PrReviewProcessorDeps = {
    resolveProject:
      userDeps.resolveProject ?? (async (job) => findProjectForRepo(`${job.owner}/${job.repo}`)),
    resolveJudge: userDeps.resolveJudge ?? (async () => null),
    resolveOctokit: userDeps.resolveOctokit ?? (async () => null),
    ...(userDeps.resolveBudget ? { resolveBudget: userDeps.resolveBudget } : {}),
  };
  const prReviewWorker = startWorker({ processorDeps });
  setPrReviewWorker(prReviewWorker);

  return { http: httpServer, io, mcp, acp, prReviewWorker };
}

function createNoopAcpHandle(): AcpServerHandle {
  return {
    get connectionCount() {
      return 0;
    },
    get wss(): null {
      return null;
    },
    async shutdown() {
      /* no-op */
    },
  };
}
