"""Unit tests for the sqlglot extraction engine — Epic #294 (#303).

Covers the acceptance criteria: multi-dialect parsing (Oracle/PL-SQL, T-SQL,
PostgreSQL, MySQL), column-level extraction, SELECT* expansion WITH schema,
OpenLineage edges, and the uncertain paths (dynamic SQL, routine bodies).
"""

from __future__ import annotations

import pytest

from app.extractor import (
    REASON_DYNAMIC,
    REASON_ROUTINE_BODY,
    extract_usage,
    normalize_dialect,
)


def _table_names(result: dict) -> set[str]:
    return {t["qualifiedName"] for t in result["tables"]}


def _columns_for(result: dict, table_qn: str) -> set[str]:
    return {c["column"] for c in result["columns"] if c["table"] == table_qn}


def _reasons(result: dict) -> set[str]:
    return {u["reason"] for u in result["uncertain"]}


def _routine_names(result: dict) -> set[str]:
    return {r["qualifiedName"] for r in result["routines"]}


# --- dialect normalization --------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("oracle", "oracle"),
        ("PL/SQL", "oracle"),
        ("tsql", "tsql"),
        ("SQLServer", "tsql"),
        ("postgres", "postgres"),
        ("PostgreSQL", "postgres"),
        ("mysql", "mysql"),
        ("mariadb", "mysql"),
        ("sas", ""),
        ("totally-unknown", ""),
        (None, ""),
        ("", ""),
    ],
)
def test_normalize_dialect(raw, expected):
    assert normalize_dialect(raw) == expected


# --- basic extraction -------------------------------------------------------


def test_empty_sql_returns_empty():
    result = extract_usage("   ", dialect="postgres")
    assert result == {
        "tables": [],
        "columns": [],
        "lineage_edges": [],
        "uncertain": [],
        "routines": [],
    }


def test_select_extracts_table_and_columns():
    result = extract_usage(
        "SELECT id, name FROM public.users WHERE active = 1", dialect="postgres"
    )
    assert _table_names(result) == {"public.users"}
    assert _columns_for(result, "public.users") == {"id", "name", "active"}
    assert result["tables"][0]["access"] == "read"


def test_insert_is_persist_access():
    result = extract_usage(
        "INSERT INTO orders (id, total) VALUES (1, 99)", dialect="postgres"
    )
    assert _table_names(result) == {"orders"}
    assert result["tables"][0]["access"] == "persist"
    assert _columns_for(result, "orders") == {"id", "total"}


def test_update_is_write_access():
    result = extract_usage(
        "UPDATE orders SET status = 'shipped' WHERE id = 5", dialect="postgres"
    )
    assert result["tables"][0]["access"] == "write"
    assert "status" in _columns_for(result, "orders")


def test_delete_is_write_access():
    result = extract_usage("DELETE FROM sessions WHERE expired = 1", dialect="postgres")
    assert result["tables"][0]["access"] == "write"


def test_join_collects_multiple_tables_with_aliased_columns():
    sql = (
        "SELECT u.id, o.total FROM users u "
        "JOIN orders o ON u.id = o.user_id WHERE u.active = 1"
    )
    result = extract_usage(sql, dialect="postgres")
    assert _table_names(result) == {"users", "orders"}
    assert "id" in _columns_for(result, "users")
    assert "total" in _columns_for(result, "orders")


def test_cte_name_is_not_reported_as_table():
    sql = (
        "WITH recent AS (SELECT id FROM orders WHERE created_at > '2024-01-01') "
        "SELECT id FROM recent"
    )
    result = extract_usage(sql, dialect="postgres")
    # `recent` is a CTE alias, not a real table.
    assert "recent" not in _table_names(result)
    assert "orders" in _table_names(result)


def test_multi_statement_merges_and_keeps_strongest_access():
    sql = "SELECT id FROM users; UPDATE users SET name = 'x' WHERE id = 1;"
    result = extract_usage(sql, dialect="postgres")
    assert _table_names(result) == {"users"}
    # persist/write beats read.
    assert result["tables"][0]["access"] == "write"


# --- SELECT * expansion (the column-accuracy lever) -------------------------


def test_select_star_without_schema_yields_no_columns():
    result = extract_usage("SELECT * FROM public.users", dialect="postgres")
    assert _table_names(result) == {"public.users"}
    # Without a schema, the star cannot be expanded — table ref only.
    assert _columns_for(result, "public.users") == set()


def test_select_star_with_schema_expands_columns():
    schema = {"public": {"users": {"id": "INT", "name": "VARCHAR", "email": "VARCHAR"}}}
    result = extract_usage("SELECT * FROM public.users", dialect="postgres", schema=schema)
    assert _columns_for(result, "public.users") == {"id", "name", "email"}


def test_schema_qualifies_bare_columns_across_join():
    schema = {
        "users": {"id": "INT", "active": "BOOLEAN"},
        "orders": {"id": "INT", "user_id": "INT", "total": "DECIMAL"},
    }
    sql = "SELECT id, total FROM users JOIN orders ON users.id = orders.user_id"
    result = extract_usage(sql, dialect="postgres", schema=schema)
    # With a schema, `id` and `total` resolve onto the right tables.
    assert "total" in _columns_for(result, "orders")


# --- lineage edges (OpenLineage, source=sqlglot) ----------------------------


def test_lineage_edges_for_simple_projection():
    schema = {"public": {"users": {"id": "INT", "name": "VARCHAR"}}}
    result = extract_usage(
        "SELECT name FROM public.users", dialect="postgres", schema=schema
    )
    edges = result["lineage_edges"]
    assert len(edges) >= 1
    edge = edges[0]
    assert edge["source"] == "sqlglot"
    assert edge["outputField"]["column"] == "name"
    assert edge["inputField"]["column"] == "name"
    assert "users" in edge["inputField"]["table"]


def test_lineage_edges_deduplicated():
    schema = {"users": {"id": "INT"}}
    # Same projection twice across statements → one edge.
    sql = "SELECT id FROM users; SELECT id FROM users;"
    result = extract_usage(sql, dialect="postgres", schema=schema)
    keys = {
        (e["inputField"]["table"], e["inputField"]["column"], e["outputField"]["column"])
        for e in result["lineage_edges"]
    }
    assert len(keys) == len(result["lineage_edges"])


# --- column-level lineage foundation (Epic #883 #901) -----------------------


def test_unqualified_column_resolves_to_correct_table_via_schema():
    """The core #901 AC: a bare column shared across joined tables lands on the
    table the schema says owns it (not the other) — column-level lineage."""
    schema = {
        "users": {"id": "INT", "name": "VARCHAR"},
        "orders": {"id": "INT", "user_id": "INT", "amount": "DECIMAL"},
    }
    # `name` exists only on users; `amount` only on orders. Both are UNqualified.
    sql = (
        "SELECT name, amount "
        "FROM users JOIN orders ON users.id = orders.user_id"
    )
    result = extract_usage(sql, dialect="postgres", schema=schema)
    assert "name" in _columns_for(result, "users")
    assert "amount" in _columns_for(result, "orders")
    # And the lineage edges attribute each source column to the right table.
    by_out = {
        e["outputField"]["column"]: e["inputField"]["table"]
        for e in result["lineage_edges"]
    }
    assert by_out.get("name") == "users"
    assert by_out.get("amount") == "orders"


def test_column_lineage_without_schema_stays_table_level():
    """No schema → no invented column edges (the ~20%->~90% lever is off). The
    table edge is still produced; unqualified columns are simply not attributed."""
    sql = "SELECT name FROM users JOIN orders ON users.id = orders.user_id"
    result = extract_usage(sql, dialect="postgres")
    assert _table_names(result) == {"users", "orders"}
    # A genuinely ambiguous bare column across two tables is never guessed.
    assert not result["lineage_edges"]


def test_sqlglot_3049_cte_star_limitation_documented():
    """Characterisation of the documented sqlglot #3049 limitation: a column
    projected out of a `SELECT *` CTE does NOT trace through the nested scope to
    its physical source table — the lineage walker stops at the CTE alias.

    This is a KNOWN-limitation guard, not an aspiration: it pins the current
    behaviour so a future sqlglot upgrade that fixes #3049 makes the test fail
    loudly (prompting us to tighten the resolution) rather than silently. The
    safety invariant still holds — the physical table edge is recovered and no
    edge is attributed to a WRONG physical table."""
    schema = {"users": {"id": "INT", "name": "VARCHAR"}}
    sql = "WITH c AS (SELECT * FROM users) SELECT name FROM c"
    result = extract_usage(sql, dialect="postgres", schema=schema)
    # The physical table is always recovered (CTE alias `c` is excluded).
    assert _table_names(result) == {"users"}
    # #3049: the `name` lineage edge resolves only to the CTE alias `c`, NOT the
    # physical `users` table — the origin is lost through the `SELECT *` scope.
    edge_tables = {e["inputField"]["table"] for e in result["lineage_edges"]}
    assert "users" not in edge_tables  # the limitation: no physical grounding
    # Whatever IS emitted never points at a wrong PHYSICAL table (only the alias).
    assert edge_tables <= {"c"}


# --- dialects ---------------------------------------------------------------


def test_tsql_top_and_bracket_identifiers():
    result = extract_usage(
        "SELECT TOP 10 [Id], [Name] FROM [dbo].[Users] WHERE [Active] = 1",
        dialect="tsql",
    )
    assert _table_names(result) == {"dbo.users"}
    assert _columns_for(result, "dbo.users") >= {"id", "name", "active"}


def test_mysql_backtick_identifiers():
    result = extract_usage(
        "SELECT `id`, `email` FROM `app`.`accounts`", dialect="mysql"
    )
    assert _table_names(result) == {"app.accounts"}
    assert _columns_for(result, "app.accounts") == {"id", "email"}


def test_oracle_select_from_dual_and_table():
    result = extract_usage(
        "SELECT employee_id, salary FROM hr.employees WHERE dept_id = 10",
        dialect="oracle",
    )
    assert _table_names(result) == {"hr.employees"}


# --- routine bodies (best-effort → routine-body-unanalyzed) -----------------


def test_oracle_plsql_procedure_body_best_effort():
    plsql = (
        "CREATE OR REPLACE PROCEDURE upd_sal AS BEGIN "
        "UPDATE employees SET salary = salary * 1.1 WHERE dept_id = 10; "
        "INSERT INTO audit_log(msg) VALUES ('done'); END;"
    )
    result = extract_usage(plsql, dialect="oracle")
    # Body calls are recovered best-effort...
    assert "employees" in _table_names(result)
    assert "audit_log" in _table_names(result)
    # ...but the routine name itself is NOT a referenced table...
    assert "upd_sal" not in _table_names(result)
    # ...and the routine-body caveat is always recorded (never droppable).
    assert REASON_ROUTINE_BODY in _reasons(result)


def test_procedure_with_unresolvable_body_is_routine_body_unanalyzed():
    # A procedure whose body is only dynamic EXEC → nothing statically resolvable.
    plsql = "CREATE PROCEDURE run_it AS BEGIN EXECUTE IMMEDIATE 'SELECT 1'; END;"
    result = extract_usage(plsql, dialect="oracle")
    assert REASON_ROUTINE_BODY in _reasons(result)


# --- dynamic / unparseable SQL → uncertain (never dropped) ------------------


def test_unparseable_sql_is_dynamic_reference():
    result = extract_usage("SELECT * FROM ", dialect="postgres")
    assert result["tables"] == []
    assert REASON_DYNAMIC in _reasons(result)


def test_garbage_input_is_dynamic_reference():
    result = extract_usage("this is not sql at all (((", dialect="postgres")
    assert REASON_DYNAMIC in _reasons(result)


def test_exec_command_degrades_to_uncertain():
    # `EXEC @sql` is a T-SQL dynamic exec sqlglot turns into a Command node.
    result = extract_usage("EXEC @sql", dialect="tsql")
    assert REASON_DYNAMIC in _reasons(result)


def test_unqualified_column_on_multi_table_is_uncertain():
    # No schema, two tables, a bare column → can't attribute it → uncertain.
    sql = "SELECT mystery FROM users JOIN orders ON users.id = orders.user_id"
    result = extract_usage(sql, dialect="postgres")
    assert REASON_DYNAMIC in _reasons(result)


# --- routine invocations (the `executes`/`calls` edge lever — #316) ---------


def test_call_statement_reports_routine_invocation():
    result = extract_usage("CALL update_inventory(5, 10)", dialect="postgres")
    assert _routine_names(result) == {"update_inventory"}
    # A named CALL is statically resolvable — NOT flagged dynamic.
    assert REASON_DYNAMIC not in _reasons(result)


def test_call_schema_qualified_routine():
    result = extract_usage("CALL app.do_sync()", dialect="mysql")
    assert _routine_names(result) == {"app.do_sync"}


def test_tsql_exec_and_execute_report_routine():
    assert _routine_names(extract_usage("EXEC dbo.RefreshTotals @id=5", dialect="tsql")) == {
        "dbo.refreshtotals"
    }
    assert _routine_names(extract_usage("EXECUTE app.compute_stats", dialect="tsql")) == {
        "app.compute_stats"
    }


def test_select_function_call_reports_routine():
    result = extract_usage("SELECT calc_total(o.id) FROM orders o", dialect="postgres")
    assert "calc_total" in _routine_names(result)
    # The table is still extracted alongside the routine reference.
    assert "orders" in _table_names(result)


def test_select_schema_qualified_function_call():
    result = extract_usage("SELECT app.calc_total(id) AS t FROM orders", dialect="postgres")
    assert "app.calc_total" in _routine_names(result)


def test_builtin_functions_are_not_reported_as_routines():
    # COUNT/SUM/UPPER are typed nodes, not user routines — no executes edges.
    result = extract_usage("SELECT COUNT(*), SUM(x), UPPER(name) FROM t", dialect="postgres")
    assert _routine_names(result) == set()


def test_dynamic_exec_reports_no_routine_and_stays_uncertain():
    # `EXEC @sql` has no resolvable routine name → no ref, recorded uncertain.
    result = extract_usage("EXEC @sql", dialect="tsql")
    assert _routine_names(result) == set()
    assert REASON_DYNAMIC in _reasons(result)


def test_routine_body_calling_another_routine_reports_callee_not_self():
    plsql = (
        "CREATE OR REPLACE PROCEDURE parent_proc AS BEGIN "
        "UPDATE employees SET salary = salary * 1.1; child_proc(); END;"
    )
    result = extract_usage(plsql, dialect="oracle")
    # The body's call to child_proc is captured as a routine reference...
    assert "child_proc" in _routine_names(result)
    # ...but the routine's OWN name is excluded (no self-call edge).
    assert "parent_proc" not in _routine_names(result)
    # ...and the routine-body caveat is still recorded.
    assert REASON_ROUTINE_BODY in _reasons(result)


def test_plain_select_has_empty_routines_list():
    result = extract_usage("SELECT id FROM users", dialect="postgres")
    assert result["routines"] == []


def test_never_executes_returns_plain_data():
    # A destructive-looking statement is only PARSED, never run. We prove the
    # parse-only contract by asserting the AST was structurally analyzed: the
    # target table is recovered as a plain reference with no side effect and no
    # column/lineage fabrication. (If anything were executed, this would error or
    # mutate state; instead we get back pure structural data.)
    result = extract_usage("DROP TABLE users", dialect="postgres")
    assert _table_names(result) == {"users"}
    assert result["tables"][0]["name"] == "users"
    # DROP is non-DML → defaults to a structural read; columns/lineage stay empty
    # because nothing was executed to materialize them.
    assert result["tables"][0]["access"] == "read"
    assert result["columns"] == []
    assert result["lineage_edges"] == []
    # Purity: extracting twice yields identical output (no hidden state / no run).
    assert extract_usage("DROP TABLE users", dialect="postgres") == result


# --- Issue #760: bind parameters + per-column access ------------------------


def _column_access(result: dict, table_qn: str) -> set[tuple[str, str]]:
    return {(c["column"], c["access"]) for c in result["columns"] if c["table"] == table_qn}


@pytest.mark.parametrize("dialect", ["", "postgres"])
def test_postgres_positional_parameters_are_never_columns(dialect):
    # miniflux `MarkAllAsRead` (entry.go:508). Under the default dialect sqlglot
    # parses `$1` as a Column, which became `entries.$1` edges (#760).
    result = extract_usage(
        "UPDATE entries SET status=$1, changed_at=now() WHERE user_id=$2 AND status=$3",
        dialect=dialect,
    )
    names = _columns_for(result, "entries")
    assert not any(n.startswith("$") for n in names)
    assert names == {"status", "changed_at", "user_id"}


def test_other_bind_parameter_shapes_are_never_columns():
    result = extract_usage(
        "DELETE FROM feeds WHERE id = $1 AND user_id = ? AND title = :title", dialect=""
    )
    assert _columns_for(result, "feeds") == {"id", "user_id", "title"}


def test_update_writes_only_set_targets_and_reads_predicates():
    result = extract_usage(
        "UPDATE entries SET status=$1, changed_at=now() WHERE user_id=$2 AND status=$3",
        dialect="",
    )
    assert _column_access(result, "entries") == {
        ("status", "write"),
        ("changed_at", "write"),
        ("user_id", "read"),
        ("status", "read"),
    }
    # The table itself is still written.
    assert result["tables"][0]["access"] == "write"


def test_tuple_set_targets_are_writes():
    result = extract_usage("UPDATE t SET (a, b) = (1, 2) WHERE c = 1", dialect="postgres")
    assert _column_access(result, "t") == {("a", "write"), ("b", "write"), ("c", "read")}


def test_delete_predicate_columns_are_reads():
    result = extract_usage("DELETE FROM sessions WHERE expired = 1", dialect="postgres")
    assert _column_access(result, "sessions") == {("expired", "read")}
    assert result["tables"][0]["access"] == "write"


def test_insert_targets_persist_and_conflict_set_targets_write():
    result = extract_usage(
        "INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT (a) DO UPDATE SET b = excluded.b",
        dialect="postgres",
    )
    access = _column_access(result, "t")
    assert ("a", "persist") in access
    assert ("b", "persist") in access
    assert ("b", "write") in access
    assert not any(n.startswith("$") for n, _ in access)


def test_merge_classifies_targets_and_predicates():
    result = extract_usage(
        "MERGE INTO t USING s ON t.id = s.id "
        "WHEN MATCHED THEN UPDATE SET t.v = s.v "
        "WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)",
        dialect="",
    )
    access = _column_access(result, "t")
    assert ("v", "write") in access
    assert ("id", "read") in access
    assert ("id", "write") not in access


def test_multi_statement_merges_column_accesses():
    sql = "SELECT name FROM users; UPDATE users SET name = 'x' WHERE id = 1;"
    result = extract_usage(sql, dialect="postgres")
    assert _column_access(result, "users") == {
        ("name", "read"),
        ("name", "write"),
        ("id", "read"),
    }


def test_merge_qualified_insert_targets_persist():
    result = extract_usage(
        "MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED THEN INSERT (t.id) VALUES (s.id)",
        dialect="",
    )
    assert _column_access(result, "t") == {("id", "read"), ("id", "persist")}


# --- Review of PR #807: unqualified write targets in multi-table statements --


@pytest.mark.parametrize("dialect", ["", "postgres"])
def test_update_from_attaches_unqualified_set_target_to_the_target_table(dialect):
    # Two tables, so the single-table fallback cannot place `a`; it is a SET
    # target, so it can only be `t`'s column.
    result = extract_usage(
        "UPDATE t SET a = $1 FROM u WHERE t.id = u.id AND u.x = $2", dialect=dialect
    )
    assert _column_access(result, "t") == {("a", "write"), ("id", "read")}
    assert _column_access(result, "u") == {("id", "read"), ("x", "read")}


def test_merge_attaches_unqualified_update_and_insert_targets_to_the_target_table():
    result = extract_usage(
        "MERGE INTO t USING s ON t.id = s.id "
        "WHEN MATCHED THEN UPDATE SET v = s.v "
        "WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)",
        dialect="",
    )
    assert _column_access(result, "t") == {
        ("id", "read"),
        ("id", "persist"),
        ("v", "write"),
        ("v", "persist"),
    }
    # The source table only ever reads.
    assert _column_access(result, "s") == {("id", "read"), ("v", "read")}


def test_insert_select_conflict_set_target_lands_on_the_insert_target():
    result = extract_usage(
        "INSERT INTO t (a, b) SELECT u.a, u.b FROM u "
        "ON CONFLICT (a) DO UPDATE SET b = 1",
        dialect="postgres",
    )
    assert ("b", "write") in _column_access(result, "t")
    assert ("b", "write") not in _column_access(result, "u")


# --- #859: write attribution by statement node, not by whole statement ------


def _table_access(result: dict) -> dict[str, str]:
    return {t["qualifiedName"]: t["access"] for t in result["tables"]}


@pytest.mark.parametrize("dialect", ["", "postgres"])
def test_update_inside_a_cte_is_a_write(dialect):
    # Miniflux SetEntriesStatusAndCountVisible: a data-modifying CTE under a
    # SELECT. `entries` is written; `feeds` (joined by the outer SELECT) is read.
    result = extract_usage(
        "WITH updated AS (UPDATE entries SET status = $1 WHERE user_id = $2 "
        "RETURNING id, feed_id) "
        "SELECT count(*) FROM updated JOIN feeds ON feeds.id = updated.feed_id",
        dialect=dialect,
    )
    assert _table_access(result) == {"entries": "write", "feeds": "read"}
    assert ("status", "write") in _column_access(result, "entries")


@pytest.mark.parametrize("dialect", ["", "postgres"])
def test_delete_and_insert_inside_ctes_keep_their_own_kind(dialect):
    result = extract_usage(
        "WITH gone AS (DELETE FROM sessions WHERE expired = 1 RETURNING user_id), "
        "logged AS (INSERT INTO audit (user_id) SELECT user_id FROM gone RETURNING 1) "
        "SELECT name FROM users",
        dialect=dialect,
    )
    assert _table_access(result) == {"sessions": "write", "audit": "persist", "users": "read"}


@pytest.mark.parametrize("dialect", ["", "postgres"])
def test_update_from_writes_only_the_target_table(dialect):
    # Miniflux MarkCategoryAsRead: `feeds` is only read through FROM.
    result = extract_usage(
        "UPDATE entries SET status = $1, changed_at = now() FROM feeds "
        "WHERE feeds.id = entries.feed_id AND feeds.category_id = $2",
        dialect=dialect,
    )
    assert _table_access(result) == {"entries": "write", "feeds": "read"}
    assert _column_access(result, "feeds") == {("category_id", "read"), ("id", "read")}


def test_delete_using_writes_only_the_target_table():
    result = extract_usage(
        "DELETE FROM entries USING feeds WHERE feeds.id = entries.feed_id", dialect="postgres"
    )
    assert _table_access(result) == {"entries": "write", "feeds": "read"}


def test_merge_source_table_is_read():
    result = extract_usage(
        "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET v = s.v",
        dialect="postgres",
    )
    assert _table_access(result) == {"t": "write", "s": "read"}


def test_insert_select_source_table_is_read():
    result = extract_usage(
        "INSERT INTO archive (id, title) SELECT e.id, e.title FROM entries e", dialect="postgres"
    )
    assert _table_access(result) == {"archive": "persist", "entries": "read"}


def test_mysql_multi_table_update_writes_only_assigned_tables():
    result = extract_usage("UPDATE a JOIN b ON a.x = b.x SET b.y = 1", dialect="mysql")
    assert _table_access(result) == {"a": "read", "b": "write"}


def test_mysql_multi_table_delete_writes_only_the_named_targets():
    result = extract_usage("DELETE a FROM a JOIN b ON a.x = b.x", dialect="mysql")
    assert _table_access(result) == {"a": "write", "b": "read"}


def test_tsql_update_through_an_alias_writes_the_aliased_table():
    # `UPDATE x ... FROM tbl x` names the target by its alias: the write lands on
    # `tbl`, and the alias is never reported as a table of its own.
    result = extract_usage(
        "UPDATE x SET y = 1 FROM tbl x JOIN u ON u.id = x.id", dialect="tsql"
    )
    assert _table_access(result) == {"tbl": "write", "u": "read"}
    assert ("y", "write") in _column_access(result, "tbl")


def test_tsql_delete_through_an_alias_writes_the_aliased_table():
    result = extract_usage("DELETE x FROM tbl x JOIN u ON u.id = x.id", dialect="tsql")
    assert _table_access(result) == {"tbl": "write", "u": "read"}


# --- #859: SQL builtins are not routines -------------------------------------


@pytest.mark.parametrize("dialect", ["", "postgres", "mysql"])
def test_sql_builtins_are_not_reported_as_routines(dialect):
    result = extract_usage(
        "SELECT now(), setweight(to_tsvector($1), 'A'), "
        "pg_size_pretty(pg_total_relation_size('entries')), jsonb_build_object('a', 1), "
        "pg_catalog.now(), calc_total(1), app.to_tsvector(2) FROM t",
        dialect=dialect,
    )
    # User routines survive, including a schema-qualified one that shares a
    # builtin's name; builtins (bare or pg_catalog-qualified) do not.
    assert _routine_names(result) == {"calc_total", "app.to_tsvector"}
