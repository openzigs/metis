"""Uvicorn entrypoint for the metis-sql-lineage sidecar — Epic #294 (#303).

Run with: ``python -m app.server`` (or via the Docker CMD). Binds to
``SQL_LINEAGE_HOST``/``SQL_LINEAGE_PORT`` (defaults 0.0.0.0:5070 — distinct from
the embeddings sidecar's 5050).
"""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.environ.get("SQL_LINEAGE_HOST", "0.0.0.0")  # noqa: S104 — sidecar binds on the pod network
    port = int(os.environ.get("SQL_LINEAGE_PORT", "5070"))
    uvicorn.run("app.api:app", host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
