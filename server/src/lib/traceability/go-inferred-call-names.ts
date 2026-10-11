/**
 * #1034 — which Go callee names "Tested by" may follow through a call the ingest
 * left unresolved.
 *
 * The Go parser stores only the bare field name of every selector call, the
 * standard library's included: `resp.Body.Close()`, `errors.New(…)` and
 * `t.Run(…)` are unresolved `Close` / `New` / `Run` edges, with no receiver kept.
 * The impact-analysis resolver (`impact-analysis/go-call-resolution.ts`) binds
 * such an edge whenever exactly one project function of that name is visible
 * from the caller's package. Over-approximating a blast radius is safe; here a
 * bound edge is a positive claim, "this test tests that code", so one stray
 * `Close` in a handler test made `storage.go::Close` read as tested.
 *
 * With the receiver gone, the name is the only evidence left, so the rule is
 * about how much a name can prove:
 *
 *  1. **Two words or more.** A one-word name (`Close`, `New`, `Run`, `Get`,
 *     `Now`, `Parse`, `String`, `Error`, `Write`, `Read`, `Do`, `Validate`, …) is
 *     the vocabulary of the standard library and of every interface in it, so a
 *     call to it says nothing about WHOSE method ran. A compound name
 *     (`SetEntriesStatus`, `CreateBookmark`, `parseLines`) carries the project's
 *     own vocabulary. This costs true links to one-word project methods
 *     (`Options.Port`, `Client.Feed`); they cannot be told from `url.Port()`.
 *  2. **Not a well-known compound name** of the standard library or `testing`
 *     ({@link COMMON_GO_COMPOUND_CALLEES}: `WithTimeout`, `NewRequest`,
 *     `ReadAll`, `ServeHTTP`, `MarshalJSON`, …). The list is curated, not
 *     complete: a compound stdlib name missing from it still has to be the single
 *     visible candidate in a package the test's package imports.
 *
 * Two more rules are applied by the caller (`loadGoResolvedEdges` in
 * tested-by.ts) because they need the calling test:
 *  - a name that fails the test above still binds when a test in the target's
 *    OWN package is named for it (`TestValidateCertFile` calling `Validate`):
 *    two weak signals that agree. Not from another package, where
 *    `TestVersionHandler` calling `runtime.Version()` bound to `client.go::Version`;
 *  - Go's own: an unexported name is callable only from its own package.
 *
 * Measured on the Miniflux v2.3.3 graph (PR #1086), over every bind the resolver
 * makes from a test symbol into a non-test function: 819 pairs, 731 kept (677 by
 * a distinctive name, 54 by a same-package test named for the callee), 88
 * dropped. The dropped set holds the false binds found by reading the source
 * (`proxyURL.String()` → `configOptions.String`, `time.Now()` → `timezone.Now`,
 * `t.Run` → `worker.Run`, `runtime.Version()` → `client.Version`) and, with
 * them, true calls to one-word methods (`Builder.Write`, `Client.Feed`) that the
 * name cannot tell apart. 24 kept pairs sampled evenly and read: 24 real calls.
 */

/** The words of a Go identifier: `SetEntriesStatus` → 3, `RootURL` → 2, `HTTPS` → 1. */
export function goNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/**
 * Compound method and function names of the Go standard library and `testing`
 * that tests and handlers call all the time. Grouped by package for review; a
 * name is listed once.
 */
export const COMMON_GO_COMPOUND_CALLEES: ReadonlySet<string> = new Set([
  // context
  "WithCancel",
  "WithCancelCause",
  "WithDeadline",
  "WithTimeout",
  "WithValue",
  "WithoutCancel",
  "AfterFunc",
  // io, bufio, os
  "ReadAll",
  "ReadAt",
  "ReadFrom",
  "ReadFull",
  "ReadByte",
  "ReadBytes",
  "ReadLine",
  "ReadRune",
  "ReadString",
  "ReadDir",
  "ReadFile",
  "WriteAt",
  "WriteTo",
  "WriteByte",
  "WriteRune",
  "WriteString",
  "WriteFile",
  "CopyN",
  "CopyBuffer",
  "LimitReader",
  "MultiReader",
  "MultiWriter",
  "NopCloser",
  "TeeReader",
  "NewReader",
  "NewWriter",
  "NewScanner",
  "NewReadWriter",
  "NewFile",
  "OpenFile",
  "CreateTemp",
  "MkdirAll",
  "MkdirTemp",
  "RemoveAll",
  "LookupEnv",
  "IsExist",
  "IsNotExist",
  "IsDir",
  "ModTime",
  "TempDir",
  "UserHomeDir",
  // bytes, strings, strconv, unicode
  "NewBuffer",
  "NewBufferString",
  "NewReplacer",
  "HasPrefix",
  "HasSuffix",
  "EqualFold",
  "ContainsAny",
  "ContainsRune",
  "IndexByte",
  "LastIndex",
  "ReplaceAll",
  "SplitN",
  "SplitSeq",
  "ToLower",
  "ToUpper",
  "ToTitle",
  "ToValidUTF8",
  "TrimLeft",
  "TrimPrefix",
  "TrimRight",
  "TrimSpace",
  "TrimSuffix",
  "FormatBool",
  "FormatFloat",
  "FormatInt",
  "FormatUint",
  "ParseBool",
  "ParseFloat",
  "ParseInt",
  "ParseUint",
  "IsDigit",
  "IsLetter",
  "IsSpace",
  "IsUpper",
  "IsLower",
  // time
  "AddDate",
  "ParseDuration",
  "ParseInLocation",
  "LoadLocation",
  "FixedZone",
  "IsZero",
  "NewTicker",
  "NewTimer",
  "UnixMicro",
  "UnixMilli",
  "UnixNano",
  // sync, atomic
  "CompareAndSwap",
  "LoadOrStore",
  "LoadAndDelete",
  "TryLock",
  "RLock",
  "RUnlock",
  // net, net/http, httptest, net/url
  "NewRequest",
  "NewRequestWithContext",
  "NewRecorder",
  "NewServer",
  "NewTLSServer",
  "NewUnstartedServer",
  "NewServeMux",
  "ServeHTTP",
  "ServeTLS",
  "ServeContent",
  "ServeFile",
  "ListenAndServe",
  "ListenAndServeTLS",
  "HandleFunc",
  "HandlerFunc",
  "WriteHeader",
  "SetCookie",
  "AddCookie",
  "FormValue",
  "PostFormValue",
  "PathValue",
  "SetPathValue",
  "ParseForm",
  "ParseMultipartForm",
  "FormFile",
  "BasicAuth",
  "SetBasicAuth",
  "UserAgent",
  "StatusText",
  "NotFound",
  "MaxBytesReader",
  "StripPrefix",
  "TimeoutHandler",
  "CloseIdleConnections",
  "RoundTrip",
  "PostForm",
  "ParseRequestURI",
  "ParseQuery",
  "QueryEscape",
  "QueryUnescape",
  "PathEscape",
  "PathUnescape",
  "JoinPath",
  "ResolveReference",
  "EscapedPath",
  "RequestURI",
  "IsAbs",
  "ParseIP",
  "ParseCIDR",
  "ParseAddr",
  "ParsePrefix",
  "SplitHostPort",
  "JoinHostPort",
  "LookupHost",
  "LookupIP",
  "DialContext",
  "DialTimeout",
  "LocalAddr",
  "RemoteAddr",
  "SetDeadline",
  "SetReadDeadline",
  "SetWriteDeadline",
  // encoding
  "MarshalJSON",
  "UnmarshalJSON",
  "MarshalText",
  "UnmarshalText",
  "MarshalBinary",
  "UnmarshalBinary",
  "MarshalXML",
  "UnmarshalXML",
  "MarshalIndent",
  "NewDecoder",
  "NewEncoder",
  "SetIndent",
  "SetEscapeHTML",
  "DisallowUnknownFields",
  "UseNumber",
  "EncodeToString",
  "DecodeString",
  "EncodeElement",
  "DecodeElement",
  // database/sql
  "BeginTx",
  "ExecContext",
  "PingContext",
  "PrepareContext",
  "QueryContext",
  "QueryRow",
  "QueryRowContext",
  "LastInsertId",
  "RowsAffected",
  "SetConnMaxIdleTime",
  "SetConnMaxLifetime",
  "SetMaxIdleConns",
  "SetMaxOpenConns",
  // path/filepath, regexp, sort, slices, maps, reflect
  "EvalSymlinks",
  "WalkDir",
  "MustCompile",
  "MatchString",
  "FindString",
  "FindStringSubmatch",
  "FindAllString",
  "FindAllStringSubmatch",
  "ReplaceAllString",
  "ReplaceAllStringFunc",
  "SliceStable",
  "SortFunc",
  "SortStableFunc",
  "BinarySearch",
  "ContainsFunc",
  "IndexFunc",
  "EqualFunc",
  "DeepEqual",
  "TypeOf",
  "ValueOf",
  // html/template, text/template, log, log/slog
  "ExecuteTemplate",
  "ParseFiles",
  "ParseGlob",
  "ParseFS",
  "SetOutput",
  "SetFlags",
  "SetPrefix",
  "SetDefault",
  "NewJSONHandler",
  "NewTextHandler",
  "LogAttrs",
  "DebugContext",
  "InfoContext",
  "WarnContext",
  "ErrorContext",
  // testing
  "FailNow",
  "SkipNow",
  "ReportAllocs",
  "ResetTimer",
  "StartTimer",
  "StopTimer",
  "RunParallel",
  "AllocsPerRun",
]);

/** True when a bound call to a function of this name is evidence the test reaches it. */
export function isDistinctiveGoCallee(name: string): boolean {
  return goNameWords(name).length >= 2 && !COMMON_GO_COMPOUND_CALLEES.has(name);
}

/** Go's export rule: an identifier is visible outside its package only when capitalised. */
export function isExportedGoName(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}
