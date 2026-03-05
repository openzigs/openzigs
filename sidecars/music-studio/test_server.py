"""
Unit tests for Music Studio sidecar — server.py endpoints.
Focuses on voice reference CRUD and request model validation.
"""

import json
import os
import sys
import uuid
from pathlib import Path
from unittest import mock

import pytest

# Add the sidecar directory to path
sys.path.insert(0, str(Path(__file__).parent))

# We need to set up env vars BEFORE importing the server module
os.environ.setdefault("GALLERY_DIR", "/tmp/test-gallery")
os.environ.setdefault("VOICE_REFS_DIR", "/tmp/test-voice-refs")

from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def clean_env(tmp_path):
    """Set up clean temp directories for each test."""
    gallery = tmp_path / "gallery"
    gallery.mkdir()
    refs = tmp_path / "voice-refs"
    refs.mkdir()

    with mock.patch.dict(os.environ, {
        "GALLERY_DIR": str(gallery),
        "VOICE_REFS_DIR": str(refs),
    }):
        # Re-patch module-level constants
        import server as srv
        original_gallery = srv.GALLERY_DIR
        original_refs = srv.VOICE_REFS_DIR
        srv.GALLERY_DIR = str(gallery)
        srv.VOICE_REFS_DIR = str(refs)
        srv.worker_state["is_busy"] = False
        srv.worker_state["current_job_id"] = None
        srv.job_progress.clear()

        yield {
            "gallery": gallery,
            "refs": refs,
        }

        srv.GALLERY_DIR = original_gallery
        srv.VOICE_REFS_DIR = original_refs


@pytest.fixture
def client():
    """Create a FastAPI test client."""
    from server import app
    return TestClient(app)


class TestHealthEndpoint:
    def test_health_returns_ok(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["is_busy"] is False


class TestGenerateRequestModel:
    def test_generate_request_with_voice_reference(self, client, clean_env):
        """Validate the updated GenerateRequest model accepts voice_reference_id."""
        ref_id = str(uuid.uuid4())
        ref_dir = Path(clean_env["refs"]) / ref_id
        ref_dir.mkdir()
        (ref_dir / "audio.wav").write_bytes(b"fake audio")
        (ref_dir / "metadata.json").write_text(json.dumps({
            "name": "Test Voice",
            "duration": 5.0,
        }))

        # Create a fake source file
        source = Path(clean_env["gallery"]) / "test-source.wav"
        source.write_bytes(b"fake source audio")

        resp = client.post("/generate", json={
            "job_id": "test-123",
            "source_path": str(source),
            "voice_reference_id": ref_id,
            "pitch_shift": 2,
            "diffusion_steps": 30,
            "f0_condition": True,
        })
        # Should be accepted (202) since worker isn't busy
        assert resp.status_code == 202
        data = resp.json()
        assert data["status"] == "accepted"

    def test_generate_rejects_missing_reference(self, client, clean_env):
        """Should return 400 when voice reference doesn't exist."""
        source = Path(clean_env["gallery"]) / "source.wav"
        source.write_bytes(b"fake")

        resp = client.post("/generate", json={
            "job_id": "test-456",
            "source_path": str(source),
            "voice_reference_id": "nonexistent-id",
        })
        assert resp.status_code == 400

    def test_generate_rejects_when_busy(self, client, clean_env):
        """Should return 409 when worker is already busy."""
        import server as srv
        srv.worker_state["is_busy"] = True
        srv.worker_state["current_job_id"] = "busy-job"

        resp = client.post("/generate", json={
            "job_id": "test-789",
            "source_path": "/tmp/fake.wav",
            "voice_reference_id": "some-id",
        })
        assert resp.status_code == 409


class TestModelsEndpoint:
    def test_models_returns_voice_references(self, client, clean_env):
        """GET /models should list voice references."""
        ref_id = "ref-001"
        ref_dir = Path(clean_env["refs"]) / ref_id
        ref_dir.mkdir()
        (ref_dir / "audio.wav").write_bytes(b"audio data")
        (ref_dir / "metadata.json").write_text(json.dumps({
            "name": "My Voice",
            "duration": 8.5,
            "created": "2025-01-01T00:00:00Z",
        }))

        resp = client.get("/models")
        assert resp.status_code == 200
        data = resp.json()
        assert data["models"] == []  # RVC models always empty
        assert len(data["voice_references"]) == 1
        assert data["voice_references"][0]["name"] == "My Voice"
        assert data["voice_references"][0]["id"] == ref_id

    def test_models_empty_when_no_refs(self, client, clean_env):
        resp = client.get("/models")
        assert resp.status_code == 200
        data = resp.json()
        assert data["models"] == []
        assert data["voice_references"] == []


class TestVoiceReferenceCRUD:
    def test_list_empty(self, client, clean_env):
        resp = client.get("/voice-references")
        assert resp.status_code == 200
        assert resp.json()["references"] == []

    def test_list_with_references(self, client, clean_env):
        for i in range(3):
            ref_dir = Path(clean_env["refs"]) / f"ref-{i}"
            ref_dir.mkdir()
            (ref_dir / "audio.wav").write_bytes(b"audio")
            (ref_dir / "metadata.json").write_text(json.dumps({
                "name": f"Voice {i}",
                "duration": 5.0 + i,
            }))

        resp = client.get("/voice-references")
        assert resp.status_code == 200
        refs = resp.json()["references"]
        assert len(refs) == 3

    def test_get_reference(self, client, clean_env):
        ref_id = "get-test"
        ref_dir = Path(clean_env["refs"]) / ref_id
        ref_dir.mkdir()
        (ref_dir / "audio.wav").write_bytes(b"audio data")
        (ref_dir / "metadata.json").write_text(json.dumps({
            "name": "Test Ref",
            "duration": 10.0,
        }))

        resp = client.get(f"/voice-references/{ref_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == ref_id
        assert data["name"] == "Test Ref"

    def test_get_reference_not_found(self, client, clean_env):
        resp = client.get("/voice-references/nonexistent")
        assert resp.status_code == 404

    def test_get_reference_audio(self, client, clean_env):
        ref_id = "audio-test"
        ref_dir = Path(clean_env["refs"]) / ref_id
        ref_dir.mkdir()
        audio_bytes = b"RIFF" + b"\x00" * 100  # fake WAV header
        (ref_dir / "audio.wav").write_bytes(audio_bytes)

        resp = client.get(f"/voice-references/{ref_id}/audio")
        assert resp.status_code == 200
        assert b"RIFF" in resp.content

    def test_rename_reference(self, client, clean_env):
        ref_id = "rename-test"
        ref_dir = Path(clean_env["refs"]) / ref_id
        ref_dir.mkdir()
        (ref_dir / "audio.wav").write_bytes(b"audio")
        (ref_dir / "metadata.json").write_text(json.dumps({
            "name": "Old Name",
            "duration": 3.0,
        }))

        resp = client.patch(f"/voice-references/{ref_id}?name=New+Name")
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "New Name"

        # Verify it persisted
        meta = json.loads((ref_dir / "metadata.json").read_text())
        assert meta["name"] == "New Name"

    def test_delete_reference(self, client, clean_env):
        ref_id = "delete-test"
        ref_dir = Path(clean_env["refs"]) / ref_id
        ref_dir.mkdir()
        (ref_dir / "audio.wav").write_bytes(b"audio")
        (ref_dir / "metadata.json").write_text(json.dumps({"name": "Delete Me"}))

        resp = client.delete(f"/voice-references/{ref_id}")
        assert resp.status_code == 200
        assert resp.json()["deleted"] == ref_id
        assert not ref_dir.exists()

    def test_delete_reference_not_found(self, client, clean_env):
        resp = client.delete("/voice-references/nonexistent")
        assert resp.status_code == 404


class TestJobStatus:
    def test_status_not_found(self, client, clean_env):
        resp = client.get("/status/nonexistent-job")
        assert resp.status_code == 404

    def test_status_returns_progress(self, client, clean_env):
        import server as srv
        srv.job_progress["test-job"] = {
            "stage": "voice_conversion",
            "progress": 50,
            "message": "Converting...",
            "status": "processing",
        }

        resp = client.get("/status/test-job")
        assert resp.status_code == 200
        data = resp.json()
        assert data["stage"] == "voice_conversion"
        assert data["progress"] == 50


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
