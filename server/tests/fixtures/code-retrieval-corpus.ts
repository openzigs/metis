/**
 * #717 — a synthetic Go repository, written for this test, in the shape of the
 * corpus the #706 walkthrough retrieved against (miniflux/v2 2.3.3). Each entry
 * is one chunk as the repository ingester stores it (`connector-ingest.ts`): a
 * `# <relPath>` header, then a fenced block.
 *
 * The shape that mattered: the DEFINITION spells its concepts as camelCase
 * identifiers (`SyncStrategy()`, `StrategyActivityBased`) while its TESTS and
 * the option table spell them as strings (`"SYNC_STRATEGY"`,
 * `"activity_based"`), many times over. A tokenizer that keeps an identifier
 * whole can only match the strings, so the definition loses to its own tests.
 */
export interface CorpusChunk {
  id: string;
  relPath: string;
  text: string;
}

const fence = "```";
function chunk(id: string, relPath: string, body: string): CorpusChunk {
  return { id, relPath, text: `# ${relPath}\n\n${fence}go\n${body}\n${fence}\n` };
}

export const DEFINITION = "internal/model/source.go#2";
export const OPTION = "internal/config/options.go#7";
export const CLI_SYNC = "internal/cli/sync_sources.go#0";
export const TRANSLATIONS = "internal/locale/en_US.json#0";

function strategyTest(name: string, strategy: string, weekly: number): string {
  return `func TestSource${name}(t *testing.T) {
	os.Clearenv()
	os.Setenv("SYNC_STRATEGY", "${strategy}")
	os.Setenv("STRATEGY_ACTIVITY_BASED_MAX_INTERVAL", strconv.Itoa(60))
	os.Setenv("STRATEGY_ACTIVITY_BASED_MIN_INTERVAL", strconv.Itoa(5))
	os.Setenv("STRATEGY_FIXED_RATE_INTERVAL", strconv.Itoa(30))

	var err error
	parser := config.NewParser()
	config.Opts, err = parser.ParseEnvironment()
	if err != nil {
		t.Fatalf("parse failure: %v", err)
	}

	before := time.Now()
	source := &Source{}
	source.PlanNextSync(${weekly}, noRetryDelay)
	if source.NextSyncAt.IsZero() {
		t.Error("next_sync_at must be set for the ${strategy} strategy")
	}
	want := config.Opts.StrategyActivityBasedMaxInterval()
	assertInterval(t, source, want, before, "${strategy} strategy sync interval")
}

func TestSource${name}ZeroActivity(t *testing.T) {
	os.Clearenv()
	os.Setenv("SYNC_STRATEGY", "${strategy}")
	source := &Source{}
	source.PlanNextSync(0, noRetryDelay)
	assertInterval(t, source, config.Opts.StrategyFixedRateInterval(), time.Now(), "${strategy} zero activity")
}`;
}

export const CORPUS: CorpusChunk[] = [
  chunk(
    "internal/model/source.go#0",
    "internal/model/source.go",
    `package model

// Source is a remote endpoint the aggregator pulls entries from.
type Source struct {
	ID            int64     \`json:"id"\`
	UserID        int64     \`json:"user_id"\`
	URL           string    \`json:"url"\`
	Title         string    \`json:"title"\`
	CheckedAt     time.Time \`json:"checked_at"\`
	NextSyncAt    time.Time \`json:"next_sync_at"\`
	ErrorCount    int       \`json:"error_count"\`
	Disabled      bool      \`json:"disabled"\`
	IgnoreCache   bool      \`json:"ignore_cache"\`
	UserAgent     string    \`json:"user_agent"\`
}`,
  ),
  chunk(
    DEFINITION,
    "internal/model/source.go",
    `// PlanNextSync sets "next_sync_at" of a source based on the strategy selected in the configuration.
func (s *Source) PlanNextSync(weeklyCount int, retryDelay time.Duration) time.Duration {
	// Default to the global fixed rate.
	interval := config.Opts.StrategyFixedRateInterval()

	if config.Opts.SyncStrategy() == StrategyActivityBased {
		if weeklyCount <= 0 {
			interval = config.Opts.StrategyActivityBasedMaxInterval()
		} else {
			interval = (7 * 24 * time.Hour) / time.Duration(weeklyCount*config.Opts.StrategyActivityBasedFactor())
			interval = min(interval, config.Opts.StrategyActivityBasedMaxInterval())
			interval = max(interval, config.Opts.StrategyActivityBasedMinInterval())
		}
	}

	// Honour the remote's own Retry-After or cache headers when they ask for longer.
	interval = max(interval, retryDelay)

	// Cap the interval for misconfigured sources.
	switch config.Opts.SyncStrategy() {
	case StrategyFixedRate:
		interval = min(interval, config.Opts.StrategyFixedRateMaxInterval())
	case StrategyActivityBased:
		interval = min(interval, config.Opts.StrategyActivityBasedMaxInterval())
	}

	s.NextSyncAt = time.Now().Add(interval)
	return interval
}`,
  ),
  chunk(
    "internal/model/source_test.go#1",
    "internal/model/source_test.go",
    strategyTest("PlanNextSyncActivityBased", "activity_based", 1),
  ),
  chunk(
    "internal/model/source_test.go#2",
    "internal/model/source_test.go",
    strategyTest("PlanNextSyncActivityBasedMax", "activity_based", 2),
  ),
  chunk(
    "internal/model/source_test.go#3",
    "internal/model/source_test.go",
    strategyTest("PlanNextSyncFixedRate", "fixed_rate", 3),
  ),
  chunk(
    "internal/model/source_test.go#4",
    "internal/model/source_test.go",
    strategyTest("PlanNextSyncFixedRateMax", "fixed_rate", 4),
  ),
  chunk(
    OPTION,
    "internal/config/options.go",
    `		"SYNC_STRATEGY": {
			ParsedStringValue: "fixed_rate",
			RawValue:          "fixed_rate",
			ValueType:         stringType,
			Validator: func(rawValue string) error {
				return validateChoices(rawValue, []string{"fixed_rate", "activity_based"})
			},
		},
		"STRATEGY_ACTIVITY_BASED_FACTOR": {
			ParsedIntValue: 1,
			RawValue:       "1",
			ValueType:      intType,
		},
		"STRATEGY_ACTIVITY_BASED_MAX_INTERVAL": {
			ParsedDuration: 24 * time.Hour,
			RawValue:       "1440",
			ValueType:      minuteType,
		},
		"STRATEGY_ACTIVITY_BASED_MIN_INTERVAL": {
			ParsedDuration: 5 * time.Minute,
			RawValue:       "5",
			ValueType:      minuteType,
		},
		"STRATEGY_FIXED_RATE_INTERVAL": {
			ParsedDuration: 60 * time.Minute,
			RawValue:       "60",
			ValueType:      minuteType,
		},`,
  ),
  chunk(
    CLI_SYNC,
    "internal/cli/sync_sources.go",
    `func syncSources(store *storage.Storage) {
	var wg sync.WaitGroup
	startTime := time.Now()

	// Build a batch of sources for every user that has sources to sync.
	jobs, err := store.NewBatchBuilder().
		WithBatchSize(config.Opts.BatchSize()).
		WithoutDisabledSources().
		WithNextSyncExpired().
		FetchJobs()
	if err != nil {
		slog.Error("Unable to fetch sync jobs", slog.Any("error", err))
		return
	}

	for _, job := range jobs {
		wg.Add(1)
		go func(job model.Job) {
			defer wg.Done()
			slog.Info("Syncing source", slog.Int64("source_id", job.SourceID))
			if err := handler.SyncSource(store, job.UserID, job.SourceID); err != nil {
				slog.Warn("Unable to sync source", slog.Any("error", err))
			}
		}(job)
	}
	wg.Wait()
	slog.Info("Sources synced", slog.Duration("duration", time.Since(startTime)))
}`,
  ),
  chunk(
    TRANSLATIONS,
    "internal/locale/en_US.json",
    `{
  "page.sources.title": "Sources",
  "page.sources.sync_all": "Sync all sources",
  "page.sources.how_often": "How often are sources checked? It depends on the strategy you are using.",
  "page.sources.next_sync": "Next sync",
  "help.sync": "Sources are synced in the background. How long it takes depends on how many sources there are and how often they are updated.",
  "help.when": "When are sources synced? When the scheduler runs, which is how often the administrator has set it to run.",
  "error.sync": "There was a problem syncing this source. Are the credentials right? Is the URL reachable? How long ago did it last work?",
  "form.how": "How are entries ordered?",
  "form.are": "Are read entries hidden?"
}`,
  ),
  chunk(
    "internal/storage/source.go#2",
    "internal/storage/source.go",
    `// UpdateSource persists a source's sync state.
func (s *Storage) UpdateSource(source *model.Source) error {
	query := \`UPDATE sources SET url=$1, title=$2, checked_at=$3, next_sync_at=$4, error_count=$5 WHERE id=$6 AND user_id=$7\`
	_, err := s.db.Exec(query, source.URL, source.Title, source.CheckedAt, source.NextSyncAt, source.ErrorCount, source.ID, source.UserID)
	if err != nil {
		return fmt.Errorf("store: unable to update source #%d: %v", source.ID, err)
	}
	return nil
}`,
  ),
];
