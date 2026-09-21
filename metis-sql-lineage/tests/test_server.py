"""Entrypoint test — Epic #294 (#303). Verifies `app.server.main()` wires uvicorn
with the configured host/port without actually binding a socket."""

from __future__ import annotations

import app.server as server


def test_main_invokes_uvicorn_with_env(monkeypatch):
    captured = {}

    def fake_run(target, host, port, log_level):  # noqa: ANN001
        captured.update(target=target, host=host, port=port, log_level=log_level)

    monkeypatch.setattr(server.uvicorn, "run", fake_run)
    monkeypatch.setenv("SQL_LINEAGE_HOST", "127.0.0.1")
    monkeypatch.setenv("SQL_LINEAGE_PORT", "6000")

    server.main()

    assert captured["target"] == "app.api:app"
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 6000
    assert captured["log_level"] == "info"


def test_main_defaults(monkeypatch):
    captured = {}
    monkeypatch.setattr(server.uvicorn, "run", lambda *a, **k: captured.update(a=a, k=k))
    monkeypatch.delenv("SQL_LINEAGE_HOST", raising=False)
    monkeypatch.delenv("SQL_LINEAGE_PORT", raising=False)

    server.main()

    assert captured["k"]["host"] == "0.0.0.0"  # noqa: S104 — asserting the default bind
    assert captured["k"]["port"] == 5070
