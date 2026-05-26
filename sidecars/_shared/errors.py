"""Shared error envelope + handlers for OpenZigs Python sidecars.

Goal: never leak raw exception text / tracebacks across the wire. The TS
proxy in ``src/sidecars/error-normalizer.ts`` expects responses of shape::

    { "error": { "code": "<machine_code>", "message": "<human_msg>",
                 "hint": "<optional remediation>"? } }

Legacy ``{"detail": "..."}`` (FastAPI HTTPException default) is still
parsed by the TS normalizer for backwards compat, but new code should
``raise SidecarError(...)`` instead.

Usage::

    from _shared.errors import SidecarError, register_error_handlers
    app = FastAPI(...)
    register_error_handlers(app, logger=logging.getLogger(__name__))

    @app.post("/infer")
    def infer():
        if not ok:
            raise SidecarError(
                code="invalid_input",
                message="Reference audio must be 3-10 seconds.",
                hint="Trim the clip and retry.",
                status=400,
            )
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException, RequestValidationError
from fastapi.responses import JSONResponse


class SidecarError(Exception):
    """Domain error raised by sidecar handlers.

    ``message`` is user-facing; ``code`` is a stable machine identifier.
    Never include sensitive data (paths, tokens, internal stack frames).
    """

    __slots__ = ("code", "message", "hint", "status")

    def __init__(
        self,
        *,
        code: str,
        message: str,
        hint: str | None = None,
        status: int = 500,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.status = status

    def to_envelope(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.hint:
            payload["hint"] = self.hint
        return {"error": payload}


def _envelope(code: str, message: str, hint: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": code, "message": message}
    if hint:
        payload["hint"] = hint
    return {"error": payload}


def register_error_handlers(
    app: FastAPI,
    *,
    logger: logging.Logger | None = None,
) -> None:
    """Install standard error handlers on ``app``.

    - ``SidecarError``     → its declared status + envelope.
    - ``HTTPException``    → wrapped into envelope (preserves status); when
      ``detail`` is already an envelope dict it is forwarded unchanged.
    - ``RequestValidationError`` → 422 with ``code='invalid_request'``;
      raw field errors are logged server-side but not echoed.
    - any other ``Exception`` → 500 with generic message, full traceback
      logged via ``logger.exception`` and NEVER returned to the client.
    """
    log = logger or logging.getLogger("openzigs.sidecar")

    @app.exception_handler(SidecarError)
    async def _on_sidecar_error(_req: Request, exc: SidecarError) -> JSONResponse:
        log.warning(
            "SidecarError code=%s status=%d message=%s",
            exc.code,
            exc.status,
            exc.message,
        )
        return JSONResponse(status_code=exc.status, content=exc.to_envelope())

    @app.exception_handler(HTTPException)
    async def _on_http_exc(_req: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail
        if isinstance(detail, dict) and "error" in detail:
            return JSONResponse(status_code=exc.status_code, content=detail)
        message = str(detail) if detail is not None else "Request failed."
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope("http_error", message),
        )

    @app.exception_handler(RequestValidationError)
    async def _on_validation(_req: Request, exc: RequestValidationError) -> JSONResponse:
        log.warning("Request validation failed: %s", exc.errors())
        return JSONResponse(
            status_code=422,
            content=_envelope(
                "invalid_request",
                "Request body failed validation.",
                "Check required fields and types.",
            ),
        )

    @app.exception_handler(Exception)
    async def _on_unhandled(_req: Request, exc: Exception) -> JSONResponse:
        # Full traceback stays server-side; client only sees a generic message.
        log.exception("Unhandled sidecar exception: %s", type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content=_envelope(
                "internal_error",
                "Internal sidecar error.",
                "Check sidecar logs for details.",
            ),
        )


__all__ = ["SidecarError", "register_error_handlers"]
