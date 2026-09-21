"""FastAPI HTTP surface for the metis-sql-lineage sidecar — Epic #294 (#303).

Mirrors the security posture of the `metis-embeddings` sidecar
(server/embeddings-svc/src/app.ts):
  * Every route except ``/healthz`` requires ``Authorization: Bearer <token>``.
  * The token is compared in constant time.
  * Missing/empty ``SQL_LINEAGE_TOKEN`` = fail closed: authenticated routes return
    503 until a shared secret is configured (running open would let any pod on the
    network spend our parser on arbitrary input).
  * Request bodies are size-limited (OWASP — reject oversized payloads before
    parsing). The service NEVER executes SQL and makes NO outbound calls.
"""

from __future__ import annotations

import hmac
import os

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__
from .extractor import extract_usage

# Upper bound on a single SQL payload. 1 MiB is generous for a procedure body or
# a fat embedded query while still rejecting abuse. Mirrors the embeddings
# sidecar's body cap intent.
MAX_SQL_BYTES = int(os.environ.get("SQL_LINEAGE_MAX_SQL_BYTES", str(1_000_000)))


class ExtractUsageRequest(BaseModel):
    """Request body for ``POST /extract_usage``."""

    sql: str = Field(..., min_length=1, description="The SQL text to analyse (parsed, never executed).")
    dialect: str | None = Field(default=None, description="SQL dialect hint (oracle|tsql|postgres|mysql|...).")
    schema_: dict | None = Field(
        default=None,
        alias="schema",
        description="Introspected schema {db:{table:{col:type}}} — the SELECT* expansion lever.",
    )

    model_config = {"populate_by_name": True}


def _read_token() -> str | None:
    """Configured shared secret, or ``None`` when unset/blank (fail-closed)."""
    raw = os.environ.get("SQL_LINEAGE_TOKEN")
    if not raw or not raw.strip():
        return None
    return raw.strip()


async def require_token(authorization: str | None = Header(default=None)) -> None:
    """Auth dependency: constant-time bearer check; 503 when unconfigured."""
    expected = _read_token()
    if expected is None:
        raise HTTPException(
            status_code=503,
            detail="SQL_LINEAGE_TOKEN is not configured — the sidecar refuses requests until a shared secret is set.",
        )
    presented = ""
    if authorization:
        parts = authorization.split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "bearer":
            presented = parts[1].strip()
    # hmac.compare_digest is constant-time and length-safe.
    if not presented or not hmac.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def create_app() -> FastAPI:
    app = FastAPI(
        title="metis-sql-lineage",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.get("/healthz")
    async def healthz() -> dict:
        return {
            "status": "ok",
            "service": "metis-sql-lineage",
            "version": __version__,
            "tokenConfigured": _read_token() is not None,
        }

    @app.post("/extract_usage", dependencies=[Depends(require_token)])
    async def extract_usage_route(request: Request) -> JSONResponse:
        # Enforce the size cap on the raw body BEFORE parsing JSON/SQL (OWASP:
        # reject oversized input cheaply). The body is always a superset of the
        # `sql` field, so this single check bounds the SQL we hand to the parser.
        body = await request.body()
        if len(body) > MAX_SQL_BYTES:
            raise HTTPException(status_code=413, detail="payload too large")
        try:
            payload = ExtractUsageRequest.model_validate_json(body)
        except ValueError as err:
            raise HTTPException(status_code=400, detail="invalid request body") from err
        result = extract_usage(payload.sql, dialect=payload.dialect, schema=payload.schema_)
        return JSONResponse(result)

    return app


app = create_app()
