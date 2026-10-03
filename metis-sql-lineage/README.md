# metis-sql-lineage

Python sidecar that extracts **SQL usage** — referenced tables, columns, and
column-level lineage edges — from SQL strings using
[`sqlglot`](https://github.com/tobymao/sqlglot). Part of METIS **Epic #294**
(Phase 3: broader SQL usage extraction).

It mirrors the deployment shape of the `metis-embeddings` sidecar
(`server/embeddings-svc/`): shared-secret auth, restricted network egress, its
own Dockerfile (`Dockerfile.sql-lineage`), and a docker-compose / Helm entry.
Unlike `metis-embeddings` (Node/ONNX), this service is **Python** —
FastAPI + uvicorn + sqlglot.

## Why a separate Python service?

`sqlglot` is the best-in-class multi-dialect SQL parser and is Python-only.
Feeding the **introspected DB schema** into sqlglot lets it expand `SELECT *`
and qualify bare columns — the documented ~20% → ~90% column-accuracy lever for
embedded-SQL analysis. The TS server locates SQL (via tree-sitter, the SAS
miner, etc.) and calls this service to resolve it.

## Contract

`POST /extract_usage`

```jsonc
// request
{
  "sql": "SELECT id, name FROM public.users WHERE active = 1",
  "dialect": "postgres",          // oracle | tsql | postgres | mysql | sas | ...
  "schema": {                      // optional — the column-accuracy lever
    "public": { "users": { "id": "INT", "name": "VARCHAR", "active": "BOOLEAN" } }
  }
}

// response
{
  "tables":  [{ "schema": "public", "name": "users", "qualifiedName": "public.users", "access": "read" }],
  "columns": [{ "table": "public.users", "column": "id", "qualifiedName": "public.users.id", "access": "read" }],
  "lineage_edges": [
    { "namespace": "metis", "inputField": {"table": "public.users", "column": "name"},
      "outputField": {"column": "name"}, "transformation": "IDENTITY", "source": "sqlglot" }
  ],
  "uncertain": []                  // [{reason, detail}] — non-empty => classify those refs `uncertain`, never drop
}
```

#### `access` semantics (#760)

- **Table `access`** is the statement's kind: `persist` for `INSERT`, `write` for
  `UPDATE` / `DELETE` / `MERGE`, `read` otherwise. Every table in a writing
  statement carries it, including a `FROM` / `USING` source table.
- **Column `access`** is per access and can differ from its table's. Only a `SET`
  target (`UPDATE`, MERGE `WHEN MATCHED THEN UPDATE`, `ON CONFLICT DO UPDATE`) is
  `write`; an `INSERT` target column (including MERGE `WHEN NOT MATCHED THEN
  INSERT (…)`) is `persist`; every predicate, join, source and projected column
  is `read`. So `DELETE FROM t WHERE x = 1` writes `t` but only reads `t.x`.
- **Column entries may repeat**, one per distinct access: `UPDATE t SET s = $1
  WHERE s = $2` returns `t.s` twice, once `write` and once `read`. A
  `(table, column, access)` triple is never repeated. A consumer whose edge does
  not carry the access (a routine's `calls` edge) must collapse the entries
  to one per `table.column`.
- **Bind parameters are never columns** (`$1`, `?`, `:name`, `@name`).
- An unqualified column in a multi-table statement is attached only when it is a
  write target (it belongs to the statement's target table); otherwise it is
  reported in `uncertain` (`unqualified column: <name>`) rather than guessed.

`GET /healthz` → `{ status, service, version, tokenConfigured }` (no auth).

### Safety

- **Never executes SQL** — only parses it. No DB connection, no outbound network.
- **Shared-secret auth** (`SQL_LINEAGE_TOKEN`) on `/extract_usage`; constant-time
  compare; **fail-closed** (503) when the secret is unset.
- **Input size limit** (`SQL_LINEAGE_MAX_SQL_BYTES`, default 1 MiB) — oversized
  payloads are rejected (413) before parsing.
- Unparseable / dynamic SQL is reported as `uncertain` (reason
  `dynamic-reference`); procedure/function bodies that cannot be fully resolved
  use `routine-body-unanalyzed`. These are **never dropped**.

## Configuration

| Env var                     | Default     | Purpose                              |
| --------------------------- | ----------- | ------------------------------------ |
| `SQL_LINEAGE_TOKEN`         | _(unset)_   | Shared secret; unset = fail-closed   |
| `SQL_LINEAGE_HOST`          | `0.0.0.0`   | Bind host                            |
| `SQL_LINEAGE_PORT`          | `5070`      | Bind port                            |
| `SQL_LINEAGE_MAX_SQL_BYTES` | `1000000`   | Max request body size (bytes)        |

On the METIS server side, point the client at the service with
`SQL_LINEAGE_URL` + `SQL_LINEAGE_TOKEN`, and enable the integration with
`SQL_LINEAGE_MODE=sidecar` (see `server/src/lib/code-graph/sql-lineage-client.ts`).

## Development

```bash
cd metis-sql-lineage
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt

ruff check .                                   # lint
pytest --cov=app --cov-fail-under=80           # tests + coverage gate
python -m app.server                           # run locally on :5070
```
