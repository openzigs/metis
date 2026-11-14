# Querying the METIS index from your agent (`metis-index-mcp`)

`metis-index-mcp` lets an external agent, such as Claude Code, Cursor or Claude Desktop, query
the index METIS builds for a project. It uses the Model Context Protocol (MCP) over stdio. It
offers eight read-only tools and makes no model call: your agent does the reasoning. Every
call runs as you. You see the projects you can read in METIS (not archived ones), and a file
whose document is restricted from you is never read, listed or found. A requirement's code link
into such a file is left out of `metis_read_requirements`; the result says how many links it
left out, never which (#2331).

| Tool                        | What it returns                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `metis_list_projects`       | The projects you can read: id, name, slug and a one-line description. Call it first.                     |
| `metis_search_code_context` | Whole functions and classes that answer a question about the code, with `file:line` locators.            |
| `metis_search_symbols`      | Keyword and semantic search over code symbols. Optional `fileGlob`, `symbolKind` and `language` filters. |
| `metis_graph_callers`       | The symbols that call a symbol, from the code graph, and probable call sites.                            |
| `metis_graph_callees`       | The symbols a symbol calls.                                                                              |
| `metis_read_file_slice`     | Up to 200 numbered lines of a repository file.                                                           |
| `metis_read_requirements`   | The project's requirements: a filtered list, or one in full with its trace.                              |
| `metis_index_status`        | The last indexed commit, how the last indexing run ended, and coverage.                                  |

Every tool except `metis_list_projects` takes a `projectId`, the id `metis_list_projects`
gives you. These tools run the same implementations as METIS chat. Each result carries:

- `result`: the text the tool returned, with secrets redacted;
- `resultCount`: how many results came back (`null` for a file read or a status report);
- `truncated`: whether results were cut;
- `citations`: for code, the path, line range, indexed commit and permalink;
- `instructions`: fixed guidance from METIS on how to use the result.

An agent that reads only the text content gets the result, then a short trailer with the count,
the truncation note and the instructions.

## Where it runs

The server runs **in process against a METIS installation's own database, vector store and
repository clones**. Launch it on a host that runs the METIS server, with the server's
environment (`DATABASE_URL`, the LanceDB path, the clone root and the embedder settings). That
is typically a developer machine running METIS locally. A remote endpoint for agents on other
machines is a separate piece of work (#2344).

**The trust boundary is the agent, not the operator.** Whoever launches the server holds the
METIS server's `DATABASE_URL` and clone root, so they can already read every project and every
restricted file directly. Your token and your access decide what the *agent* is given, not what
the person running the process could read. On a shared host, launch it only where the operator
is already trusted with the whole METIS installation.

## Your credential

The server does not use a shared service secret. It needs **your own METIS API token**
(`metis_…`) with the `acp:read` scope:

- a system admin creates one under **Settings → ACP tokens**;
- any signed-in user can create one with `POST /api/acp/tokens`. Ask for `acp:read` only:
  `{"name": "my agent", "scopes": ["acp:read"]}`. This server needs nothing more, and a token
  minted without scopes gets `acp:run` as well.

METIS shows the token once. Keep it out of files you commit. METIS checks it again on **every
call**. Revoking the token, disabling your account or removing you from a workspace takes
effect on the agent's next call. METIS refuses a token that is unknown, revoked, expired or
lacks `acp:read`, and does not say which.

## Launching it

From a built server (`pnpm --filter @metis/server build`):

```bash
cd server
METIS_API_TOKEN=metis_… node --env-file=../.env dist/mcp/metis-index/server.js
```

From source, during development:

```bash
METIS_API_TOKEN=metis_… pnpm --filter @metis/server metis-index-mcp
```

The server refuses to start without a token that resolves to an active user. It writes nothing
to stdout except MCP messages; its logs go to stderr.

## Client configuration

**Claude Code** (`.mcp.json` in your project, or `claude mcp add`):

```json
{
  "mcpServers": {
    "metis-index": {
      "command": "node",
      "args": [
        "--env-file=/path/to/metis/.env",
        "/path/to/metis/server/dist/mcp/metis-index/server.js"
      ],
      "cwd": "/path/to/metis/server",
      "env": { "METIS_API_TOKEN": "${METIS_API_TOKEN}" }
    }
  }
}
```

Export `METIS_API_TOKEN` in your shell rather than writing the token into the file.

**Claude Desktop / Cursor**: the same `command`, `args` and `env` under `mcpServers` in the
client's MCP settings file.

## What METIS records

Each call is audit-logged as `mcp.index.tool_call` with your user id, the tool,
the project and the result count. A refused credential is logged as `mcp.index.denied` with
the tool and the reason. METIS never logs a result body or the arguments, such as your query
or a file path.

## Measured

On the BA question set (`pnpm eval:ba-qa`, Sonnet 5.5, 23 questions), an agent using these
tools through an MCP client matched or beat chat's in-process tools on answer quality. It used
about a third more input tokens, because it called `metis_search_code_context`, which that
in-process arm does not offer. The numbers are in `eval-data/README.md`, "The index over MCP
(#2331)".
