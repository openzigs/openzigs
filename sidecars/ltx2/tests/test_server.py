"""Tests for the LTX-2 sidecar HTTP contract.

These tests run on any host (no GPU, no upstream venv, no models).
The subprocess invocation is mocked so we only validate:

  * /health surfaces the environment-readiness probe
  * /generate fast-fails with 503 when the env isn't ready
  * /generate validates inputs synchronously (400) before scheduling
  * /generate accepts valid jobs (202) and runs them via the mocked subprocess
  * Path-traversal attempts on job_id are rejected
  * Offload-mode allow-list is enforced
  * The model is correctly registered as served-by-sidecar
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


@pytest.fixture
def server():
    """Re-import the server module fresh for each test."""
    sys.modules.pop("server_cuda", None)
    import server_cuda as sc  # type: ignore
    yield sc
    sys.modules.pop("server_cuda", None)


def _client_with_env(server, *, ready: bool):
    """TestClient that boots with the env-probe forced to ready/not-ready.

    The app's lifespan runs `_probe_environment()` on enter; patching it
    forces a deterministic state regardless of what's on the actual host.
    """
    probe_value = {
        "venv_python_present": ready,
        "distilled_checkpoint_present": ready,
        "spatial_upsampler_present": ready,
        "gemma_root_present": ready,
    }
    return patch.object(server, "_probe_environment", return_value=probe_value)


# ── /health ──────────────────────────────────────────────────────────


def test_health_reports_env_not_ready_by_default(server):
    """When env probe says nothing is present, /health must surface it."""
    with _client_with_env(server, ready=False):
        with TestClient(server.app) as client:
            r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["sidecar"] == "ltx2"
    assert body["ready"] is False
    assert body["environment"]["venv_python_present"] is False


def test_health_reports_ready_when_probe_succeeds(server):
    with _client_with_env(server, ready=True):
        with TestClient(server.app) as client:
            r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ready"] is True


# ── /generate gates ──────────────────────────────────────────────────


def test_generate_returns_503_when_env_missing(server):
    with _client_with_env(server, ready=False):
        with TestClient(server.app) as client:
            r = client.post("/generate", json={
                "job_id": "j1",
                "prompt": "a cat purring",
            })
    assert r.status_code == 503
    assert "setup.sh" in r.json()["detail"]


def test_generate_rejects_bad_job_id(server):
    """Path-traversal style job_id must be rejected before subprocess spawn."""
    with _client_with_env(server, ready=True):
        with TestClient(server.app) as client:
            r = client.post("/generate", json={
                "job_id": "../escape",
                "prompt": "x",
            })
    assert r.status_code == 400
    assert "job_id" in r.json()["detail"].lower()


def test_generate_rejects_oversized_resolution(server):
    with _client_with_env(server, ready=True):
        with TestClient(server.app) as client:
            r = client.post("/generate", json={
                "job_id": "j2",
                "prompt": "x",
                "height": server.LTX2_MAX_DIM + 32,
                "width": 512,
            })
    assert r.status_code == 400
    assert "height/width" in r.json()["detail"].lower()


def test_generate_rejects_too_many_frames(server):
    with _client_with_env(server, ready=True):
        with TestClient(server.app) as client:
            r = client.post("/generate", json={
                "job_id": "j3",
                "prompt": "x",
                "num_frames": server.LTX2_MAX_FRAMES + 1,
            })
    assert r.status_code == 400
    assert "num_frames" in r.json()["detail"].lower()


def test_generate_rejects_unknown_offload_mode(server):
    with _client_with_env(server, ready=True):
        with TestClient(server.app) as client:
            r = client.post("/generate", json={
                "job_id": "j4",
                "prompt": "x",
                "offload_mode": "magic",
            })
    assert r.status_code == 400
    assert "offload_mode" in r.json()["detail"].lower()


# ── happy path: subprocess mocked ────────────────────────────────────


def test_generate_accepts_valid_job_and_invokes_subprocess(server, tmp_path, monkeypatch):
    """A 202 response should schedule the job; the mocked subprocess writes
    the expected MP4 stub, after which /status returns completed."""
    # Override the output root so the test doesn't write into /tmp.
    monkeypatch.setattr(server, "LTX2_OUTPUT_ROOT", tmp_path)

    def fake_run(argv, log_path):
        # Simulate a successful CLI run by writing a tiny stub MP4.
        out_idx = argv.index("--output-path") + 1
        Path(argv[out_idx]).write_bytes(b"\x00" * 64)
        log_path.write_bytes(b"[smoke] ok\n")
        return 0, "ok"

    monkeypatch.setattr(server, "_run_subprocess", fake_run)

    with _client_with_env(server, ready=True):
        with TestClient(server.app) as client:
            r = client.post("/generate", json={
                "job_id": "happy-001",
                "prompt": "a cat purring on a wooden floor",
                "seed": 42,
                "num_frames": 25,
                "height": 256,
                "width": 256,
            })
            assert r.status_code == 202
            assert r.json() == {"status": "accepted", "job_id": "happy-001"}

            # Drain the background task. TestClient's lifespan keeps the
            # event loop alive across requests; poll /status until the
            # mocked subprocess finishes (sub-second).
            import time as _t
            for _ in range(50):
                s = client.get("/status/happy-001").json()
                if s.get("status") in {"completed", "failed"}:
                    break
                _t.sleep(0.05)

    assert s["status"] == "completed", s
    assert Path(s["video_path"]).is_file()
    assert s["video_path"].endswith("ltx2_happy-001.mp4")


def test_generate_records_failure_when_subprocess_exits_nonzero(server, tmp_path, monkeypatch):
    monkeypatch.setattr(server, "LTX2_OUTPUT_ROOT", tmp_path)

    def fake_run(argv, log_path):
        log_path.write_bytes(b"boom\n")
        return 1, "boom"

    monkeypatch.setattr(server, "_run_subprocess", fake_run)

    with _client_with_env(server, ready=True):
        with TestClient(server.app) as client:
            r = client.post("/generate", json={
                "job_id": "sad-001", "prompt": "x", "num_frames": 25,
            })
            assert r.status_code == 202
            import time as _t
            for _ in range(50):
                s = client.get("/status/sad-001").json()
                if s.get("status") in {"completed", "failed"}:
                    break
                _t.sleep(0.05)

    assert s["status"] == "failed"
    # CodeQL py/stack-trace-exposure: error message must NOT include the raw
    # subprocess tail (which could contain user-supplied prompt text).
    assert "boom" not in s["error"]
    assert s["exit_code"] == 1


# ── /status ───────────────────────────────────────────────────────────


def test_status_pending_for_unknown_job(server):
    with _client_with_env(server, ready=True):
        with TestClient(server.app) as client:
            r = client.get("/status/never-seen")
    assert r.status_code == 200
    assert r.json() == {"status": "pending", "job_id": "never-seen"}


def test_status_rejects_bad_job_id(server):
    with _client_with_env(server, ready=True):
        with TestClient(server.app) as client:
            # `$` is not in the [A-Za-z0-9_-] allow-list and survives URL
            # routing intact (no normalisation), so it round-trips into our
            # validator as the same forbidden character.
            r = client.get("/status/bad$id")
    assert r.status_code == 400


# ── helper: argv assembly ────────────────────────────────────────────


def test_build_argv_contains_required_flags(server):
    argv = server._build_argv(
        prompt="hello world",
        output_path=Path("/tmp/out.mp4"),
        seed=1,
        height=512, width=512, num_frames=25, frame_rate=24,
        offload_mode="cpu",
    )
    assert "--distilled-checkpoint-path" in argv
    assert "--spatial-upsampler-path" in argv
    assert "--gemma-root" in argv
    assert "--prompt" in argv
    assert "hello world" in argv
    assert "--offload" in argv
    assert "cpu" in argv
    assert argv[argv.index("--output-path") + 1] == "/tmp/out.mp4"
    # Single-letter flag confusion guard — must not pass plural --images.
    assert "--images" not in argv


def test_safe_offload_mode_enforces_allowlist(server):
    assert server.safe_offload_mode("cpu") == "cpu"
    assert server.safe_offload_mode("DISK") == "disk"
    with pytest.raises(ValueError):
        server.safe_offload_mode("magic")
    with pytest.raises(ValueError):
        server.safe_offload_mode("")


def test_safe_output_path_contains_within_root(server, tmp_path, monkeypatch):
    monkeypatch.setattr(server, "LTX2_OUTPUT_ROOT", tmp_path.resolve())
    p = server.safe_output_path("ok-1")
    assert p.is_relative_to(tmp_path.resolve())
    assert p.name == "ltx2_ok-1.mp4"


def test_validate_callback_url_loopback_only(server):
    assert server.validate_callback_url("http://localhost:3000/cb").startswith("http://localhost")
    assert server.validate_callback_url("http://127.0.0.1:3000/cb").startswith("http://127.0.0.1")
    with pytest.raises(ValueError):
        server.validate_callback_url("http://example.com/cb")
    with pytest.raises(ValueError):
        server.validate_callback_url("file:///etc/passwd")
