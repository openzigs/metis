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


def _statement_access(statement: exp.Expression) -> str:
    """Classify a top-level statement's access kind for schema-graph edges."""
    if isinstance(statement, exp.Insert):
        return ACCESS_PERSIST
    if isinstance(statement, (exp.Update, exp.Delete, exp.Merge)):
        return ACCESS_WRITE
    # SELECT / WITH / CTE / set-ops and anything else default to a read.
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
    """Collect referenced tables keyed by qualified name.

    ``exclude`` holds routine self-names (a CREATE PROCEDURE target) that must not
    be reported as a referenced table.
    """
    tables: dict[str, dict] = {}
    # CTE names are local aliases, not real tables — exclude them.
    cte_names = {_norm(cte.alias_or_name) for cte in statement.find_all(exp.CTE)}
    for table in statement.find_all(exp.Table):
        if _is_dynamic_table(table):
            continue
        schema, name = _table_identity(table)
        if not name or name in exclude or name in cte_names:
            continue
        qn = _table_qualified_name(schema, name)
        tables.setdefault(qn, {"schema": schema, "name": name, "columns": set()})

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
                            tables[qn]["columns"].add(col)
    return tables


def _attach_columns(statement: exp.Expression, tables: dict[str, dict]) -> set[str]:
    """Attach resolved columns to their tables. Returns unqualified column names
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
        if not col or col == "*":
            continue
        tbl_ref = _norm(column.table) if column.table else ""
        if tbl_ref and tbl_ref in alias_to_qn:
            qn = alias_to_qn[tbl_ref]
            if qn in tables:
                tables[qn]["columns"].add(col)
                continue
        if len(tables) == 1:
            # Single-table statement: an unqualified column belongs to it.
            only_qn = next(iter(tables))
            tables[only_qn]["columns"].add(col)
        else:
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
        an ``Anonymous`` node (built-ins like COUNT/SUM are typed nodes, NOT
        Anonymous, so they are correctly excluded).

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
        add(schema_by_anon.get(id(anon), ""), anon.name)

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
    access_rank = {ACCESS_READ: 0, ACCESS_WRITE: 1, ACCESS_PERSIST: 2}
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
        access = _statement_access(statement)

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
                    "access": access,
                    "columns": set(info["columns"]),
                }
            else:
                if access_rank[access] > access_rank[existing["access"]]:
                    existing["access"] = access
                existing["columns"].update(info["columns"])

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
            result["columns"].append(
                {
                    "table": qn,
                    "column": col,
                    "qualifiedName": f"{qn}.{col}",
                    "access": info["access"],
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
