"""Tests for the shared sidecar error envelope + handlers."""

from __future__ import annotations

import logging

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

from errors import SidecarError, register_error_handlers


def _make_app() -> FastAPI:
    app = FastAPI()
    register_error_handlers(app, logger=logging.getLogger("test"))

    class Echo(BaseModel):
        value: int

    @app.post("/echo")
    def echo(body: Echo):  # noqa: ANN001
        return {"value": body.value}

    @app.get("/boom-sidecar")
    def boom_sidecar():
        raise SidecarError(
            code="invalid_input",
            message="Bad ref clip.",
            hint="Use 3-10s.",
            status=400,
        )

    @app.get("/boom-sidecar-bare")
    def boom_sidecar_bare():
        raise SidecarError(code="boom", message="Boom.")

    @app.get("/boom-http")
    def boom_http():
        raise HTTPException(status_code=404, detail="missing")

    @app.get("/boom-http-envelope")
    def boom_http_envelope():
        raise HTTPException(
            status_code=409,
            detail={"error": {"code": "conflict", "message": "Already exists."}},
        )

    @app.get("/boom-runtime")
    def boom_runtime():
        # Should NOT leak the message "secret path /etc/shadow" to the client.
        raise RuntimeError("secret path /etc/shadow")

    return app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(_make_app(), raise_server_exceptions=False)


def test_sidecar_error_returns_envelope_with_hint(client: TestClient) -> None:
    res = client.get("/boom-sidecar")
    assert res.status_code == 400
    assert res.json() == {
        "error": {
            "code": "invalid_input",
            "message": "Bad ref clip.",
            "hint": "Use 3-10s.",
        }
    }


def test_sidecar_error_omits_hint_when_missing(client: TestClient) -> None:
    res = client.get("/boom-sidecar-bare")
    assert res.status_code == 500
    assert res.json() == {"error": {"code": "boom", "message": "Boom."}}


def test_http_exception_is_wrapped_in_envelope(client: TestClient) -> None:
    res = client.get("/boom-http")
    assert res.status_code == 404
    body = res.json()
    assert body == {"error": {"code": "http_error", "message": "missing"}}


def test_http_exception_passthrough_when_already_envelope(client: TestClient) -> None:
    res = client.get("/boom-http-envelope")
    assert res.status_code == 409
    assert res.json() == {
        "error": {"code": "conflict", "message": "Already exists."}
    }


def test_unhandled_exception_returns_generic_message(client: TestClient) -> None:
    res = client.get("/boom-runtime")
    assert res.status_code == 500
    body = res.json()
    # Must NEVER echo the raw exception text.
    assert "secret" not in str(body).lower()
    assert "/etc/shadow" not in str(body)
    assert body == {
        "error": {
            "code": "internal_error",
            "message": "Internal sidecar error.",
            "hint": "Check sidecar logs for details.",
        }
    }


def test_validation_error_returns_invalid_request_envelope(client: TestClient) -> None:
    res = client.post("/echo", json={"value": "not-a-number"})
    assert res.status_code == 422
    body = res.json()
    assert body["error"]["code"] == "invalid_request"
    assert "validation" in body["error"]["message"].lower()
    # No leaked raw pydantic error details.
    assert "value" not in body["error"]["message"]


def test_sidecar_error_to_envelope_shape() -> None:
    err = SidecarError(code="x", message="m", hint="h", status=418)
    assert err.to_envelope() == {
        "error": {"code": "x", "message": "m", "hint": "h"}
    }
    assert err.status == 418
    bare = SidecarError(code="x", message="m")
    assert bare.to_envelope() == {"error": {"code": "x", "message": "m"}}
