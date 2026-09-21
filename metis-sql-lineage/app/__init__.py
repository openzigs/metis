"""metis-sql-lineage — Python sidecar that extracts SQL usage via sqlglot.

Epic #294 (Phase 3). Mirrors the deployment shape of the `metis-embeddings`
sidecar (shared-secret auth, restricted egress, own Dockerfile) but is a
PYTHON service: FastAPI + uvicorn + sqlglot. It never executes SQL — it only
*parses* it — and it makes no outbound network calls.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
