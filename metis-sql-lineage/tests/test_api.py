"""Auth + contract tests for the metis-sql-lineage HTTP surface — Epic #294 (#303).

Mirrors server/embeddings-svc/tests/app.test.ts: exercises routing, validation,
auth, and the fail-closed behaviour without ever executing SQL.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-secret-token-12345"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("SQL_LINEAGE_TOKEN", TOKEN)
    # Reimport so create_app() reads the patched env via the module-level `app`.
    import app.api as api_module

    importlib.reload(api_module)
    return TestClient(api_module.create_app())


def _auth(token: str = TOKEN) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_healthz_no_auth(client):
    res = client.get("/healthz")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "metis-sql-lineage"
    assert body["tokenConfigured"] is True


def test_extract_requires_bearer(client):
    res = client.post("/extract_usage", json={"sql": "SELECT 1"})
    assert res.status_code == 401


def test_extract_rejects_wrong_token(client):
    res = client.post(
        "/extract_usage", json={"sql": "SELECT 1"}, headers=_auth("nope")
    )
    assert res.status_code == 401


def test_fail_closed_when_token_unset(monkeypatch):
    monkeypatch.delenv("SQL_LINEAGE_TOKEN", raising=False)
    import app.api as api_module

    importlib.reload(api_module)
    c = TestClient(api_module.create_app())
    res = c.post("/extract_usage", json={"sql": "SELECT 1"}, headers=_auth("anything"))
    assert res.status_code == 503


def test_extract_validates_body(client):
    res = client.post("/extract_usage", json={"dialect": "postgres"}, headers=_auth())
    # Missing required `sql`.
    assert res.status_code == 400


def test_extract_rejects_empty_sql(client):
    res = client.post("/extract_usage", json={"sql": ""}, headers=_auth())
    assert res.status_code == 400


def test_extract_happy_path(client):
    res = client.post(
        "/extract_usage",
        json={"sql": "SELECT id, name FROM public.users", "dialect": "postgres"},
        headers=_auth(),
    )
    assert res.status_code == 200
    body = res.json()
    assert any(t["qualifiedName"] == "public.users" for t in body["tables"])
    assert {"tables", "columns", "lineage_edges", "uncertain", "routines"} <= set(body.keys())


def test_extract_reports_routine_invocation(client):
    res = client.post(
        "/extract_usage",
        json={"sql": "CALL app.do_sync()", "dialect": "mysql"},
        headers=_auth(),
    )
    assert res.status_code == 200
    assert any(r["qualifiedName"] == "app.do_sync" for r in res.json()["routines"])


def test_extract_passes_schema_for_star_expansion(client):
    res = client.post(
        "/extract_usage",
        json={
            "sql": "SELECT * FROM public.users",
            "dialect": "postgres",
            "schema": {"public": {"users": {"id": "INT", "name": "VARCHAR"}}},
        },
        headers=_auth(),
    )
    assert res.status_code == 200
    cols = {c["column"] for c in res.json()["columns"]}
    assert cols == {"id", "name"}


def test_extract_rejects_oversized_payload(client, monkeypatch):
    big = "SELECT 1 --" + ("a" * 1_000_001)
    res = client.post(
        "/extract_usage", json={"sql": big, "dialect": "postgres"}, headers=_auth()
    )
    assert res.status_code == 413


def test_unparseable_returns_200_with_uncertain(client):
    # The service degrades gracefully — bad SQL is data, not an error.
    res = client.post(
        "/extract_usage", json={"sql": "SELECT * FROM", "dialect": "postgres"}, headers=_auth()
    )
    assert res.status_code == 200
    assert res.json()["uncertain"]
