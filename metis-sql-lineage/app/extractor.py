"""SQL usage extraction engine (sqlglot) — Epic #294 (#303).

Pure functions that turn a SQL string + dialect (+ optional introspected schema)
into the table / column / lineage-edge inventory the METIS schema graph consumes.

Design contract (NEVER violated here):
  * We only PARSE SQL — we never execute it, never open a DB connection, and never
    make a network call. The module imports nothing but ``sqlglot``.
  * Feeding the introspected ``schema`` lets sqlglot expand ``SELECT *`` and qualify
    bare columns — the documented ~20%->~90% column-accuracy lever. Without a
    schema we degrade gracefully (table refs only; star columns stay unexpanded).
  * Anything sqlglot cannot statically resolve (a dynamic-SQL fragment, an ``EXEC``
    that degrades to a ``Command`` node, a PL/SQL body whose calls can't be traced)
    is reported as ``uncertain`` with a reason code — it is NEVER silently dropped.
    The ``routine-body-unanalyzed`` reason is reserved for procedure/function
    bodies and is never droppable.
  * Lineage edges use OpenLineage column-lineage vocabulary with ``source='sqlglot'``.

The TS client (#304) and the embedded-SQL / SAS scanners (#305/#306) call this via
the HTTP surface in :mod:`app.api`; the persistence into the code graph happens on
the TS side.
"""

from __future__ import annotations

import re

import sqlglot
from sqlglot import exp
from sqlglot.dialects.dialect import Dialect
from sqlglot.errors import OptimizeError, ParseError, SqlglotError
from sqlglot.lineage import lineage as sqlglot_lineage
from sqlglot.optimizer.qualify import qualify

# ---------------------------------------------------------------------------
# Dialect handling
# ---------------------------------------------------------------------------

# Map the dialect identifiers the METIS server sends → sqlglot dialect names.
# The epic calls out Oracle/PL-SQL, T-SQL, PostgreSQL and MySQL specifically.
_DIALECT_ALIASES: dict[str, str] = {
    "oracle": "oracle",
    "plsql": "oracle",
    "pl/sql": "oracle",
    "tsql": "tsql",
    "t-sql": "tsql",
    "mssql": "tsql",
    "sqlserver": "tsql",
    "transactsql": "tsql",
    "postgres": "postgres",
    "postgresql": "postgres",
    "pg": "postgres",
    "redshift": "redshift",
    "mysql": "mysql",
    "mariadb": "mysql",
    "sqlite": "sqlite",
    "snowflake": "snowflake",
    "bigquery": "bigquery",
    "spark": "spark",
    "hive": "hive",
    # SAS PROC SQL is ANSI-ish; parse it under the permissive default dialect.
    "sas": "",
    "ansi": "",
    "": "",
}

# Reason codes — MUST stay in lockstep with `UsageUncertainReason` in
# packages/shared/src/schema-impact.ts.
REASON_DYNAMIC = "dynamic-reference"
REASON_ROUTINE_BODY = "routine-body-unanalyzed"

# Access kinds — map to the schema-graph edge kinds reads/writes/persists-to.
ACCESS_READ = "read"
ACCESS_WRITE = "write"
ACCESS_PERSIST = "persist"

# Statement roots that define a routine whose body we analyse best-effort.
_ROUTINE_CREATE_KINDS = {"PROCEDURE", "FUNCTION"}


def normalize_dialect(dialect: str | None) -> str:
    """Return the sqlglot dialect name for a caller-supplied identifier.

    Unknown identifiers fall back to the permissive default dialect ("") rather
    than raising — an unparseable statement then surfaces as ``uncertain``.
    """
    if not dialect:
        return ""
    return _DIALECT_ALIASES.get(dialect.strip().lower(), "")


# ---------------------------------------------------------------------------
# Identifier helpers
# ---------------------------------------------------------------------------


def _norm(name: str | None) -> str:
    """Lower-case + strip quoting/brackets, matching the TS schema-graph writer."""
    if not name:
        return ""
    return name.strip().strip('`"[]').lower()


def _table_identity(table: exp.Table) -> tuple[str, str]:
    """Return ``(schema, name)`` for a table node; schema may be ""."""
    return _norm(table.db), _norm(table.name)


def _table_qualified_name(schema: str, name: str) -> str:
    return f"{schema}.{name}" if schema else name


# ---------------------------------------------------------------------------
# Schema (for SELECT * expansion + column qualification)
# ---------------------------------------------------------------------------
#
# Column-level lineage — known sqlglot limitations (Epic #883 #901)
# -----------------------------------------------------------------
# Feeding the introspected ``schema`` (see ``buildIntrospectedSchemaFromSymbols``
# on the TS side, or ``driver.introspect()`` via ``buildIntrospectedSchema``) is
# the documented ~20%->~90% column-accuracy lever: with it, ``qualify`` expands
# ``SELECT *`` and attaches bare columns to the right table across joins. It is
# NOT a complete solution — these are the cases sqlglot cannot resolve even WITH
# a schema, and how this module degrades (always safely — never a wrong edge):
#
#   * sqlglot #3049 — a bare column projected out of a ``SELECT *`` CTE / subquery
#     is not traced back to its physical source table: the lineage walker stops at
#     the CTE ALIAS instead of resolving through the nested star scope. Affected:
#     ``WITH cte AS (SELECT * FROM t) SELECT col FROM cte`` — the ``col`` edge's
#     ``inputField.table`` is ``cte``, not ``t``. Degradation: the physical TABLE
#     edge for ``t`` is still produced (CTE names are excluded from the table set),
#     and no edge is ever attributed to a WRONG physical table — the column edge
#     merely grounds on the alias. See the characterisation test
#     ``test_sqlglot_3049_cte_star_limitation_documented``.
#   * Genuinely ambiguous unqualified columns — a bare column that exists on more
#     than one joined table with no alias qualifier is inherently unresolvable.
#     ``_attach_columns`` only auto-attaches an unqualified column when the
#     statement has EXACTLY ONE table; otherwise it is reported ``uncertain``
#     (``dynamic-reference``) rather than guessed.
#   * A column absent from the supplied schema (stale/partial introspection) stays
#     unqualified. ``validate_qualify_columns=False`` keeps parsing the rest of
#     the statement instead of raising, so partial schemas still help.
#
# The invariant across all three: we never emit a column edge we cannot ground.


def _has_schema(schema: dict | None) -> bool:
    return bool(schema)


def _try_qualify(expression: exp.Expression, schema: dict | None, dialect: str) -> exp.Expression:
    """Best-effort ``qualify`` so ``SELECT *`` expands and bare columns gain a table.

    Returns the qualified expression on success, or the original expression when
    qualification fails (e.g. an incomplete schema). Never raises.
    """
    if not _has_schema(schema):
        return expression
    try:
        return qualify(
            expression.copy(),
            schema=schema,
            dialect=dialect or None,
            # Keep going even if a column can't be resolved against the schema —
            # we still want the tables and the columns we *can* resolve.
            validate_qualify_columns=False,
            quote_identifiers=False,
            identify=False,
        )
    except (OptimizeError, SqlglotError, KeyError, ValueError):
        return expression


# ---------------------------------------------------------------------------
# Core extraction
# ---------------------------------------------------------------------------


_ACCESS_RANK = {ACCESS_READ: 0, ACCESS_WRITE: 1, ACCESS_PERSIST: 2}

# Statement nodes that modify a table. They are found wherever they sit in the
# tree — a top-level statement, a data-modifying CTE (`WITH u AS (UPDATE ...)
# SELECT ...`) or a routine body — so a write is classified by its own node, not
# by the statement that happens to contain it (#859).
_WRITE_NODES = (exp.Insert, exp.Update, exp.Delete, exp.Merge)


def _write_node_access(node: exp.Expression) -> str:
    return ACCESS_PERSIST if isinstance(node, exp.Insert) else ACCESS_WRITE


def _resolve_target_ref(ref: exp.Table, scope: exp.Expression) -> exp.Table:
    """Resolve a write target named by an alias to the table it aliases (#859).

    T-SQL ``UPDATE x SET ... FROM tbl x`` / ``DELETE x FROM tbl x`` and MySQL
    ``DELETE a FROM a JOIN b`` name the target by alias or name; the real table is
    declared elsewhere in the same statement. A target that carries its own alias
    or schema is already the real table."""
    if ref.alias or ref.db:
        return ref
    name = _norm(ref.name)
    for table in scope.find_all(exp.Table):
        if table is not ref and table.alias and _norm(table.alias) == name:
            return table
    return ref


def _write_targets(node: exp.Expression) -> list[exp.Table]:
    """The Table nodes a write node actually writes (#859): the UPDATE / DELETE /
    MERGE / INSERT target only — never a table it merely reads through
    FROM / USING / JOIN / a source SELECT. A MERGE ``WHEN MATCHED THEN UPDATE``
    clause has no table of its own and yields nothing (the MERGE carries it)."""
    if isinstance(node, exp.Insert):
        target = node.this
        if isinstance(target, exp.Schema):
            target = target.this
        refs = [target]
    elif isinstance(node, exp.Delete):
        # Multi-table DELETE (`DELETE a FROM a JOIN b`) lists its targets.
        refs = list(node.args.get("tables") or []) or [node.this]
    elif isinstance(node, exp.Update) and isinstance(node.this, exp.Table) and node.this.args.get("joins"):
        # MySQL multi-table UPDATE (`UPDATE a JOIN b ... SET b.y = 1`): only the
        # tables whose columns are assigned are written.
        joined = [node.this, *(j.this for j in node.this.args["joins"] if isinstance(j.this, exp.Table))]
        by_ref = {_norm(t.alias or t.name): t for t in joined}
        assigned = {
            _norm(eq.this.table)
            for eq in node.expressions
            if isinstance(eq, exp.EQ) and isinstance(eq.this, exp.Column) and eq.this.table
        }
        refs = [by_ref[r] for r in sorted(assigned) if r in by_ref] or [node.this]
    else:
        refs = [node.this]
    return [
        _resolve_target_ref(ref, node)
        for ref in refs
        if isinstance(ref, exp.Table) and not _is_dynamic_table(ref)
    ]


def _raw_target_refs(node: exp.Expression) -> list[exp.Table]:
    refs = list(node.args.get("tables") or []) if isinstance(node, exp.Delete) else []
    refs.append(node.this)
    return [r for r in refs if isinstance(r, exp.Table)]


def _table_write_accesses(statement: exp.Expression) -> tuple[dict[int, str], set[int]]:
    """Map ``id(Table node)`` → write/persist access for every write target in the
    statement, and return the ids of target references that were only an alias
    for another table (those are not tables in their own right)."""
    accesses: dict[int, str] = {}
    alias_refs: set[int] = set()
    for node in statement.find_all(*_WRITE_NODES):
        access = _write_node_access(node)
        for target in _write_targets(node):
            current = accesses.get(id(target), ACCESS_READ)
            if _ACCESS_RANK[access] > _ACCESS_RANK[current]:
                accesses[id(target)] = access
        # A target named by alias resolves to another node; the alias node itself
        # (T-SQL `UPDATE x ... FROM tbl x`) must not surface as a table `x`.
        for ref in _raw_target_refs(node):
            resolved = _resolve_target_ref(ref, node)
            if resolved is not ref:
                alias_refs.add(id(ref))
    return accesses, alias_refs


# A bind parameter is never a column (#760). Under the permissive default
# dialect sqlglot parses a Postgres positional parameter (`$1`) as a Column
# named "$1" (`?`, `:name` and `@name` already parse as Placeholder/Parameter
# nodes, never as Columns). Anchored literal pattern (ReDoS-safe).
_POSITIONAL_PARAM_RE = re.compile(r"^\$\d+$")


def _is_bind_parameter(column: exp.Column) -> bool:
    return bool(_POSITIONAL_PARAM_RE.match(column.name or ""))


def _is_assignment_target(column: exp.Column) -> bool:
    """True when ``column`` is the left side of a ``SET col = ...`` assignment in an
    UPDATE, a MERGE ``WHEN MATCHED THEN UPDATE`` or an ``ON CONFLICT DO UPDATE``.
    A tuple target (``SET (a, b) = (...)``) counts for each of its columns."""
    node: exp.Expression = column
    if isinstance(node.parent, exp.Tuple):
        node = node.parent
    eq = node.parent
    if not isinstance(eq, exp.EQ) or node.arg_key != "this":
        return False
    return eq.arg_key == "expressions" and isinstance(eq.parent, (exp.Update, exp.OnConflict))


def _is_insert_target(column: exp.Column) -> bool:
    """True for a MERGE ``WHEN NOT MATCHED THEN INSERT (a, b)`` target column."""
    parent = column.parent
    return (
        isinstance(parent, exp.Tuple)
        and parent.arg_key == "this"
        and isinstance(parent.parent, exp.Insert)
    )


def _column_access(column: exp.Column) -> str:
    """Per-column access (#760). Only the columns actually assigned are written
    (or persisted, for INSERT targets); predicate, join and source columns are
    reads — so "who writes ``entries.user_id``?" does not match a
    ``WHERE user_id = ...``. Decided by the column's own position, so a SET inside
    a data-modifying CTE under a SELECT is still a write (#859)."""
    if _is_assignment_target(column):
        return ACCESS_WRITE
    if _is_insert_target(column):
        return ACCESS_PERSIST
    return ACCESS_READ


def _routine_target_names(statement: exp.Expression) -> set[str]:
    """Names of routines/objects DEFINED by a CREATE so we don't treat the routine's
    own name as a referenced table."""
    names: set[str] = set()
    if isinstance(statement, exp.Create):
        this = statement.this
        # CREATE PROCEDURE/FUNCTION wraps the signature in different nodes per
        # dialect; pull any identifier we can find on the create target.
        if isinstance(this, exp.Table):
            names.add(_norm(this.name))
        for ident in statement.find_all(exp.Identifier):
            # Only the first identifier is the routine name in practice, but
            # adding the create target name is enough to exclude self-references.
            if statement.kind and statement.kind.upper() in _ROUTINE_CREATE_KINDS:
                names.add(_norm(ident.name))
                break
    return names


def _is_routine_definition(statement: exp.Expression) -> bool:
    return (
        isinstance(statement, exp.Create)
        and bool(statement.kind)
        and statement.kind.upper() in _ROUTINE_CREATE_KINDS
    )


def _is_dynamic_table(table: exp.Table) -> bool:
    """True when a ``Table`` node is actually a dynamic placeholder, not a real
    object — e.g. ``EXEC @sql`` parses to ``Table(Parameter(Var(sql)))``. Such a
    reference is dynamic SQL and must never be reported as a concrete table."""
    return table.find(exp.Parameter) is not None or table.find(exp.Placeholder) is not None


def _collect_tables(statement: exp.Expression, exclude: set[str]) -> dict[str, dict]:
    """Collect referenced tables keyed by qualified name, each with its own access
    (read, or write/persist when it is a write node's target — #859).

    ``exclude`` holds routine self-names (a CREATE PROCEDURE target) that must not
    be reported as a referenced table.
    """
    tables: dict[str, dict] = {}
    # CTE names are local aliases, not real tables — exclude them.
    cte_names = {_norm(cte.alias_or_name) for cte in statement.find_all(exp.CTE)}
    write_accesses, alias_refs = _table_write_accesses(statement)
    for table in statement.find_all(exp.Table):
        if _is_dynamic_table(table) or id(table) in alias_refs:
            continue
        schema, name = _table_identity(table)
        if not name or name in exclude or name in cte_names:
            continue
        qn = _table_qualified_name(schema, name)
        info = tables.setdefault(qn, {"schema": schema, "name": name, "access": ACCESS_READ, "columns": {}})
        # Only a write node's own target is written (#859); every other
        # reference — FROM / USING / JOIN / a source SELECT — is a read.
        access = write_accesses.get(id(table), ACCESS_READ)
        if _ACCESS_RANK[access] > _ACCESS_RANK[info["access"]]:
            info["access"] = access

    # INSERT target columns live in the `Schema` node (`INSERT INTO t (a, b) ...`)
    # as Identifier children, NOT as Column nodes, so attach them here.
    if isinstance(statement, exp.Insert) and isinstance(statement.this, exp.Schema):
        target = statement.this.find(exp.Table)
        if target is not None and not _is_dynamic_table(target):
            schema, name = _table_identity(target)
            qn = _table_qualified_name(schema, name)
            if qn in tables:
                for ident in statement.this.expressions:
                    if isinstance(ident, exp.Identifier):
                        col = _norm(ident.name)
                        if col:
                            tables[qn]["columns"].setdefault(col, set()).add(ACCESS_PERSIST)
    return tables


def _write_target_qn(column: exp.Column) -> str | None:
    """Qualified name of the table a SET / MERGE-INSERT target column writes to
    (#807): the nearest enclosing UPDATE, MERGE or INSERT's own target. A MERGE
    ``WHEN MATCHED THEN UPDATE`` / ``WHEN NOT MATCHED THEN INSERT (a, b)`` clause
    has no table of its own, so the walk continues up to the MERGE; an
    ``ON CONFLICT DO UPDATE`` reaches the INSERT. A dynamic target never made it
    into ``tables``, so the caller's membership check drops it."""
    node = column.parent
    while node is not None:
        if isinstance(node, (exp.Update, exp.Merge, exp.Insert)):
            targets = _write_targets(node)
            if targets:
                return _table_qualified_name(*_table_identity(targets[0]))
        node = node.parent
    return None


def _attach_columns(statement: exp.Expression, tables: dict[str, dict]) -> set[str]:
    """Attach resolved columns (with their per-column access, #760) to their
    tables. Bind parameters are skipped. Returns unqualified column names
    (columns we could not tie to a specific table) for diagnostics."""
    # Build alias → qualified-name map so `u.email` (u = users) lands on `users`.
    alias_to_qn: dict[str, str] = {}
    for table in statement.find_all(exp.Table):
        schema, name = _table_identity(table)
        if not name:
            continue
        qn = _table_qualified_name(schema, name)
        alias = _norm(table.alias) if table.alias else ""
        if alias:
            alias_to_qn[alias] = qn
        alias_to_qn.setdefault(name, qn)

    unqualified: set[str] = set()
    for column in statement.find_all(exp.Column):
        col = _norm(column.name)
        if not col or col == "*" or _is_bind_parameter(column):
            continue
        access = _column_access(column)
        tbl_ref = _norm(column.table) if column.table else ""
        if tbl_ref and tbl_ref in alias_to_qn:
            qn = alias_to_qn[tbl_ref]
            if qn in tables:
                tables[qn]["columns"].setdefault(col, set()).add(access)
                continue
        if len(tables) == 1:
            # Single-table statement: an unqualified column belongs to it.
            only_qn = next(iter(tables))
            tables[only_qn]["columns"].setdefault(col, set()).add(access)
            continue
        if access != ACCESS_READ:
            # A SET / MERGE-INSERT target can only belong to the statement's
            # target table, however many tables the statement reads (#807).
            target_qn = _write_target_qn(column)
            if target_qn in tables:
                tables[target_qn]["columns"].setdefault(col, set()).add(access)
                continue
        unqualified.add(col)
    return unqualified


def _lineage_edges(
    statement: exp.Expression, schema: dict | None, dialect: str
) -> list[dict]:
    """Derive OpenLineage column-lineage edges for a single SELECT-bearing
    statement. Best-effort: any failure yields no edges (never raises)."""
    edges: list[dict] = []
    # Lineage only makes sense for queries that project columns.
    select = statement if isinstance(statement, exp.Select) else statement.find(exp.Select)
    if select is None:
        return edges
    try:
        output_columns = [
            projection.alias_or_name
            for projection in select.selects
            if projection.alias_or_name and projection.alias_or_name != "*"
        ]
    except SqlglotError:
        return edges

    for out_col in output_columns:
        try:
            node = sqlglot_lineage(
                out_col,
                statement,
                schema=schema if _has_schema(schema) else None,
                dialect=dialect or None,
            )
        except (SqlglotError, KeyError, ValueError, RecursionError):
            continue
        for downstream in node.downstream:
            # downstream.name is "<table>.<column>" when resolved to a source.
            if "." not in downstream.name:
                continue
            tbl, _, col = downstream.name.rpartition(".")
            if not tbl or not col:
                continue
            edges.append(
                {
                    "namespace": "metis",
                    "inputField": {"table": _norm(tbl), "column": _norm(col)},
                    "outputField": {"column": _norm(out_col)},
                    "transformation": "IDENTITY",
                    "source": "sqlglot",
                }
            )
    return edges


# SQL builtins are not routines (#859). sqlglot types most builtins (COUNT, UPPER,
# ...) so they never reach the Anonymous path, but which ones it types depends on
# the dialect — under the permissive default `now()` is Anonymous — and it leaves
# many Postgres builtins untyped altogether (`to_tsvector`, `pg_size_pretty`).
# Every name sqlglot knows as a function in the dialects METIS targets, plus the
# Postgres builtins it does not model. Only an unqualified or `pg_catalog.` call is
# treated as a builtin: Postgres resolves unqualified names through `pg_catalog`
# first, while `app.to_tsvector(...)` is a user routine that shares the name.
_BUILTIN_SCHEMAS = {"", "pg_catalog"}
_POSTGRES_BUILTINS = {
    # text search
    "to_tsvector", "to_tsquery", "plainto_tsquery", "phraseto_tsquery", "websearch_to_tsquery",
    "setweight", "ts_rank", "ts_rank_cd", "ts_headline", "tsvector_to_array", "array_to_tsvector",
    "numnode", "querytree", "strip",
    # sizes, locks, notifications and session/system information
    "pg_size_pretty", "pg_size_bytes", "pg_total_relation_size", "pg_relation_size",
    "pg_table_size", "pg_indexes_size", "pg_database_size", "pg_column_size",
    "pg_advisory_lock", "pg_advisory_unlock", "pg_advisory_xact_lock", "pg_try_advisory_lock",
    "pg_try_advisory_xact_lock", "pg_notify", "pg_sleep", "pg_backend_pid", "pg_typeof",
    "pg_get_serial_sequence", "pg_cancel_backend", "pg_terminate_backend", "current_setting",
    "set_config", "txid_current", "version",
    # sequences
    "nextval", "currval", "setval", "lastval",
    # json / jsonb
    "json_build_object", "jsonb_build_object", "json_build_array", "jsonb_build_array",
    "json_agg", "jsonb_agg", "json_object_agg", "jsonb_object_agg", "jsonb_set", "jsonb_insert",
    "json_array_elements", "jsonb_array_elements", "json_array_elements_text",
    "jsonb_array_elements_text", "json_each", "jsonb_each", "json_each_text", "jsonb_each_text",
    "json_array_length", "jsonb_array_length", "jsonb_typeof", "jsonb_strip_nulls",
    "jsonb_pretty", "jsonb_path_query", "to_json", "to_jsonb", "row_to_json",
    # arrays, dates, strings
    "array_append", "array_remove", "array_position", "array_cat", "cardinality",
    "array_to_string", "string_to_array", "clock_timestamp", "statement_timestamp",
    "transaction_timestamp", "timeofday", "make_interval", "age", "justify_interval",
    "quote_ident", "quote_literal", "quote_nullable", "format", "uuid_generate_v4",
}


def _known_builtins() -> frozenset[str]:
    names = set(_POSTGRES_BUILTINS)
    for dialect in ("", "postgres", "mysql", "tsql", "oracle"):
        parser = Dialect.get_or_raise(dialect or None).parser_class
        names.update(_norm(name) for name in parser.FUNCTIONS)
    return frozenset(names)


_BUILTIN_FUNCTIONS = _known_builtins()


def _is_builtin_call(schema: str, name: str) -> bool:
    return _norm(schema) in _BUILTIN_SCHEMAS and _norm(name) in _BUILTIN_FUNCTIONS


def _routine_ref(schema: str, name: str) -> dict:
    qn = f"{schema}.{name}" if schema else name
    return {"schema": schema, "name": name, "qualifiedName": qn}


# A `CALL`/`EXEC`/`EXECUTE` command's payload is the routine invocation text, e.g.
# ``update_inventory(5, 10)`` or ``app.do_sync()``. Pull the (optional schema +)
# routine name off the front. Anchored + bounded (Semgrep/ReDoS-safe).
_CALL_TARGET_RE = re.compile(
    r"^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|$)"
)
# Statement-level keyword introducing a routine invocation in a Command node.
_ROUTINE_COMMAND_KEYWORDS = {"CALL", "EXEC", "EXECUTE"}


def _collect_routine_refs(
    statement: exp.Expression, exclude: set[str]
) -> dict[str, dict]:
    """Collect routine (procedure/function) INVOCATIONS referenced by a statement,
    keyed by qualified name — Epic #294 / #316.

    Three invocation shapes are recognised:
      * ``CALL [schema.]proc(...)`` / ``EXEC[UTE] [schema.]proc`` — sqlglot models
        these as a ``Command`` (CALL) or ``Execute`` node.
      * ``SELECT [schema.]fn(...)`` — a user-defined function call sqlglot leaves as
        an ``Anonymous`` node. Built-ins are excluded: most are typed nodes (COUNT,
        SUM), and the untyped rest are filtered by name (``_is_builtin_call``).

    ``exclude`` holds CREATE PROCEDURE/FUNCTION target names so a routine body does
    not report a self-call. The caller turns each ref into a code→routine
    ``executes`` edge (or, for a routine body, a routine→routine ``calls`` edge).
    """
    refs: dict[str, dict] = {}

    def add(schema: str, name: str) -> None:
        name_n = _norm(name)
        if not name_n or name_n in exclude:
            return
        schema_n = _norm(schema)
        ref = _routine_ref(schema_n, name_n)
        refs.setdefault(ref["qualifiedName"], ref)

    # CALL <proc> — Command node whose payload holds the invocation text. The
    # payload is a string Literal, so read its raw value (``.sql()`` would re-quote
    # it). A payload that is just a parameter (`CALL @x`) yields no name → dynamic.
    if isinstance(statement, exp.Command):
        keyword = statement.this.strip().upper() if isinstance(statement.this, str) else ""
        payload_node = statement.expression
        payload = ""
        if isinstance(payload_node, exp.Literal):
            payload = str(payload_node.this)
        elif payload_node is not None:
            payload = payload_node.sql()
        if keyword in _ROUTINE_COMMAND_KEYWORDS and payload:
            m = _CALL_TARGET_RE.match(payload)
            if m:
                add(m.group(1) or "", m.group(2))
        return refs

    # EXEC/EXECUTE <proc> — Execute node whose `this` is a Table(name, db). A
    # dynamic target (`EXEC @sql` → Table(Parameter(...))) is NOT a named routine.
    for ex in statement.find_all(exp.Execute):
        target = ex.this
        if isinstance(target, exp.Table) and not _is_dynamic_table(target):
            add(_norm(target.db), _norm(target.name))

    # SELECT fn(...) and schema.fn(...) — Anonymous function calls. A schema
    # qualifier lands in a wrapping Dot(Identifier, Anonymous).
    schema_by_anon: dict[int, str] = {}
    for dot in statement.find_all(exp.Dot):
        if isinstance(dot.expression, exp.Anonymous) and isinstance(dot.this, exp.Identifier):
            schema_by_anon[id(dot.expression)] = dot.this.name
    for anon in statement.find_all(exp.Anonymous):
        schema = schema_by_anon.get(id(anon), "")
        if not _is_builtin_call(schema, anon.name):
            add(schema, anon.name)

    return refs


def _empty_result() -> dict:
    return {"tables": [], "columns": [], "lineage_edges": [], "uncertain": [], "routines": []}


def _uncertain(reason: str, detail: str) -> dict:
    return {"reason": reason, "detail": detail[:280]}


def extract_usage(sql: str, dialect: str | None = None, schema: dict | None = None) -> dict:
    """Extract tables / columns / lineage edges from a SQL string.

    Returns a dict with keys:
      * ``tables``        — ``[{schema, name, qualifiedName, access}]``
      * ``columns``       — ``[{table, column, qualifiedName, access}]``
      * ``lineage_edges`` — OpenLineage column-lineage edges (``source='sqlglot'``)
      * ``routines``      — ``[{schema, name, qualifiedName}]`` routine
                            (procedure/function) INVOCATIONS referenced by the SQL
                            (``CALL``/``EXEC``/``EXECUTE`` proc, ``SELECT fn(...)``).
                            The caller turns these into code→routine ``executes``
                            edges, or routine→routine ``calls`` edges for a body
                            (Epic #294 / #316).
      * ``uncertain``     — ``[{reason, detail}]`` for anything unresolved. A
                            non-empty list means the caller must classify the
                            affected refs ``uncertain`` (never drop them).

    Never raises for malformed input — unparseable SQL becomes an ``uncertain``
    entry with ``dynamic-reference``.
    """
    result = _empty_result()
    text = (sql or "").strip()
    if not text:
        return result

    resolved_dialect = normalize_dialect(dialect)

    try:
        statements = sqlglot.parse(text, dialect=resolved_dialect or None)
    except (ParseError, SqlglotError, RecursionError) as err:
        result["uncertain"].append(_uncertain(REASON_DYNAMIC, str(err)))
        return result

    # Accumulate across statements, merging tables/columns by qualified name and
    # keeping the strongest access (persist > write > read) per table.
    access_rank = _ACCESS_RANK
    table_acc: dict[str, dict] = {}
    # Routine invocations referenced anywhere across the statements (#316),
    # keyed by qualified name so a routine called twice is reported once.
    routine_acc: dict[str, dict] = {}

    for statement in statements:
        if statement is None:
            continue
        is_routine = _is_routine_definition(statement)

        # `CALL proc(...)`, `EXEC[UTE] proc`, and other unsupported / dynamic-exec
        # constructs surface as a Command node (sqlglot fell back) or an Execute
        # node. A named routine invocation (`CALL update_inventory(...)`) IS a
        # statically-resolvable `executes` reference and is captured here; a
        # genuinely dynamic exec (`EXEC @sql`) resolves to NO routine name and is
        # recorded as uncertain (never dropped) so it is not silently lost.
        if isinstance(statement, (exp.Command, exp.Execute)):
            cmd_refs = _collect_routine_refs(statement, set())
            for qn, ref in cmd_refs.items():
                routine_acc.setdefault(qn, ref)
            if not cmd_refs:
                reason = REASON_ROUTINE_BODY if is_routine else REASON_DYNAMIC
                result["uncertain"].append(
                    _uncertain(reason, statement.sql(dialect=resolved_dialect or None))
                )
            continue

        qualified = _try_qualify(statement, schema, resolved_dialect)
        exclude = _routine_target_names(statement)
        tables = _collect_tables(qualified, exclude)
        unqualified_cols = _attach_columns(qualified, tables)

        # Routine invocations referenced by this statement (#316): `SELECT fn(...)`
        # in app code → a code→routine `executes` edge; a routine BODY calling
        # another routine → a routine→routine `calls` edge. The CREATE target's
        # own name is excluded so a body never reports a self-call.
        for qn, ref in _collect_routine_refs(qualified, exclude).items():
            routine_acc.setdefault(qn, ref)

        if is_routine:
            # Procedure / function bodies are analysed best-effort. If we recovered
            # nothing, flag the body as unanalyzed (never droppable). If we DID
            # recover refs, still record the routine-body caveat so a reviewer
            # knows the call graph may be incomplete (dynamic SQL inside the body).
            if not tables:
                result["uncertain"].append(
                    _uncertain(REASON_ROUTINE_BODY, statement.sql(dialect=resolved_dialect or None))
                )
            else:
                result["uncertain"].append(
                    _uncertain(REASON_ROUTINE_BODY, "routine body parsed best-effort; calls may be incomplete")
                )

        # An unqualified column on a multi-table statement could not be tied to a
        # table — surface it as uncertain rather than guessing.
        for col in unqualified_cols:
            result["uncertain"].append(_uncertain(REASON_DYNAMIC, f"unqualified column: {col}"))

        for qn, info in tables.items():
            existing = table_acc.get(qn)
            if existing is None:
                table_acc[qn] = {
                    "schema": info["schema"],
                    "name": info["name"],
                    "access": info["access"],
                    "columns": {c: set(a) for c, a in info["columns"].items()},
                }
            else:
                if access_rank[info["access"]] > access_rank[existing["access"]]:
                    existing["access"] = info["access"]
                for col, accesses in info["columns"].items():
                    existing["columns"].setdefault(col, set()).update(accesses)

        result["lineage_edges"].extend(_lineage_edges(qualified, schema, resolved_dialect))

    # Materialize the accumulated tables/columns deterministically.
    for qn in sorted(table_acc):
        info = table_acc[qn]
        result["tables"].append(
            {
                "schema": info["schema"],
                "name": info["name"],
                "qualifiedName": qn,
                "access": info["access"],
            }
        )
        for col in sorted(info["columns"]):
            # One entry per (column, access): `SET status = $1 WHERE status = $3`
            # both writes and reads `status` (#760).
            for col_access in sorted(info["columns"][col], key=access_rank.__getitem__):
                result["columns"].append(
                    {
                        "table": qn,
                        "column": col,
                        "qualifiedName": f"{qn}.{col}",
                        "access": col_access,
                    }
                )

    # Materialize routine invocations deterministically (#316).
    for qn in sorted(routine_acc):
        result["routines"].append(routine_acc[qn])

    # De-duplicate lineage edges (statement copies can repeat them).
    seen: set[tuple] = set()
    unique_edges: list[dict] = []
    for edge in result["lineage_edges"]:
        key = (
            edge["inputField"]["table"],
            edge["inputField"]["column"],
            edge["outputField"]["column"],
        )
        if key in seen:
            continue
        seen.add(key)
        unique_edges.append(edge)
    result["lineage_edges"] = unique_edges

    return result
