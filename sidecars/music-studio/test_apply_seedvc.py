"""
Unit tests for apply_seedvc.py — Seed-VC voice conversion wrapper.
"""

import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

import pytest

# Add the sidecar directory to path
sys.path.insert(0, str(Path(__file__).parent))

from apply_seedvc import ensure_seed_vc_installed, apply_seedvc


class TestEnsureSeedVcInstalled:
    """Tests for ensure_seed_vc_installed()."""

    def test_returns_existing_path(self, tmp_path: Path):
        """When seed-vc repo exists with inference.py, returns path directly."""
        seed_dir = tmp_path / "seed-vc"
        seed_dir.mkdir()
        (seed_dir / "inference.py").write_text("# stub")

        with mock.patch("apply_seedvc.SEED_VC_DIR", str(seed_dir)):
            result = ensure_seed_vc_installed()
            assert result == str(seed_dir)

    def test_clones_when_missing(self, tmp_path: Path):
        """When seed-vc directory doesn't exist, clones from GitHub."""
        seed_dir = tmp_path / "seed-vc-new"

        with mock.patch("apply_seedvc.SEED_VC_DIR", str(seed_dir)):
            with mock.patch("subprocess.run") as mock_run:
                mock_run.return_value = mock.Mock(returncode=0)
                # After "clone", create the directory so path check passes next time
                def side_effect(*args, **kwargs):
                    seed_dir.mkdir(parents=True, exist_ok=True)
                    (seed_dir / "inference.py").write_text("# stub")
                    return mock.Mock(returncode=0)

                mock_run.side_effect = side_effect
                result = ensure_seed_vc_installed()

                mock_run.assert_called_once()
                call_args = mock_run.call_args[0][0]
                assert "git" in call_args
                assert "clone" in call_args
                assert str(seed_dir) in call_args


class TestApplySeedvc:
    """Tests for apply_seedvc()."""

    def test_raises_on_missing_input(self, tmp_path: Path):
        """Should raise FileNotFoundError when input file doesn't exist."""
        with pytest.raises(FileNotFoundError, match="Input file not found"):
            apply_seedvc(
                input_path=str(tmp_path / "missing.wav"),
                output_path=str(tmp_path / "out.wav"),
                reference_path=str(tmp_path / "ref.wav"),
            )

    def test_raises_on_missing_reference(self, tmp_path: Path):
        """Should raise FileNotFoundError when reference file doesn't exist."""
        input_file = tmp_path / "input.wav"
        input_file.write_bytes(b"fake wav data")

        with pytest.raises(FileNotFoundError, match="Reference file not found"):
            apply_seedvc(
                input_path=str(input_file),
                output_path=str(tmp_path / "out.wav"),
                reference_path=str(tmp_path / "missing_ref.wav"),
            )

    def test_successful_conversion(self, tmp_path: Path):
        """With valid files and mocked subprocess, should produce output."""
        input_file = tmp_path / "vocals.wav"
        ref_file = tmp_path / "ref.wav"
        output_file = tmp_path / "converted.wav"

        input_file.write_bytes(b"fake input")
        ref_file.write_bytes(b"fake reference")

        seed_dir = tmp_path / "seed-vc"
        seed_dir.mkdir()
        (seed_dir / "inference.py").write_text("# stub")

        def mock_subprocess_run(cmd, **kwargs):
            # Simulate seed-vc writing output
            output_dir = None
            for i, arg in enumerate(cmd):
                if arg == "--output" and i + 1 < len(cmd):
                    output_dir = cmd[i + 1]
                    break
            if output_dir:
                out_path = Path(output_dir) / "vc_vocals_ref_0.wav"
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(b"converted audio data")
            return mock.Mock(returncode=0, stdout="", stderr="")

        with mock.patch("apply_seedvc.SEED_VC_DIR", str(seed_dir)):
            with mock.patch("subprocess.run", side_effect=mock_subprocess_run):
                result = apply_seedvc(
                    input_path=str(input_file),
                    output_path=str(output_file),
                    reference_path=str(ref_file),
                    pitch_shift=2,
                    diffusion_steps=10,
                    f0_condition=True,
                    device="cpu",
                )

                assert result == str(output_file)
                assert output_file.exists()
                assert output_file.read_bytes() == b"converted audio data"

    def test_raises_on_subprocess_failure(self, tmp_path: Path):
        """Should raise RuntimeError when seed-vc subprocess fails."""
        input_file = tmp_path / "vocals.wav"
        ref_file = tmp_path / "ref.wav"
        input_file.write_bytes(b"fake input")
        ref_file.write_bytes(b"fake ref")

        seed_dir = tmp_path / "seed-vc"
        seed_dir.mkdir()
        (seed_dir / "inference.py").write_text("# stub")

        with mock.patch("apply_seedvc.SEED_VC_DIR", str(seed_dir)):
            with mock.patch("subprocess.run") as mock_run:
                mock_run.return_value = mock.Mock(
                    returncode=1,
                    stdout="",
                    stderr="CUDA out of memory"
                )

                with pytest.raises(RuntimeError, match="Seed-VC inference failed"):
                    apply_seedvc(
                        input_path=str(input_file),
                        output_path=str(tmp_path / "out.wav"),
                        reference_path=str(ref_file),
                    )

    def test_cmd_includes_all_params(self, tmp_path: Path):
        """Verify the subprocess command includes all expected flags."""
        input_file = tmp_path / "vocals.wav"
        ref_file = tmp_path / "ref.wav"
        input_file.write_bytes(b"fake")
        ref_file.write_bytes(b"fake")

        seed_dir = tmp_path / "seed-vc"
        seed_dir.mkdir()
        (seed_dir / "inference.py").write_text("# stub")

        captured_cmd = []

        def mock_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            # Create output so it doesn't error
            output_dir = None
            for i, arg in enumerate(cmd):
                if arg == "--output" and i + 1 < len(cmd):
                    output_dir = cmd[i + 1]
                    break
            if output_dir:
                Path(output_dir).mkdir(parents=True, exist_ok=True)
                (Path(output_dir) / "vc_test.wav").write_bytes(b"data")
            return mock.Mock(returncode=0, stdout="", stderr="")

        with mock.patch("apply_seedvc.SEED_VC_DIR", str(seed_dir)):
            with mock.patch("subprocess.run", side_effect=mock_run):
                apply_seedvc(
                    input_path=str(input_file),
                    output_path=str(tmp_path / "out.wav"),
                    reference_path=str(ref_file),
                    pitch_shift=-3,
                    diffusion_steps=50,
                    f0_condition=False,
                    device="mps",
                )

        assert "--source" in captured_cmd
        assert "--target" in captured_cmd
        assert "--diffusion-steps" in captured_cmd
        assert "50" in captured_cmd
        assert "--semi-tone-shift" in captured_cmd
        assert "-3" in captured_cmd
        assert "--f0-condition" in captured_cmd
        assert "False" in captured_cmd
        assert "--fp16" in captured_cmd
        assert "True" in captured_cmd  # mps enables fp16


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
