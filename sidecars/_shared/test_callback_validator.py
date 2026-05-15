"""Regression tests for server-controlled callback URL trust policy."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from callback_validator import is_safe_callback_url, validate_callback_url


class CallbackValidatorTests(unittest.TestCase):
    """Tests for the sidecar callback SSRF allowlist."""

    def test_allows_local_and_lan_without_env(self) -> None:
        """Local development and private-network primary servers stay compatible."""
        with patch.dict("os.environ", {}, clear=True):
            self.assertTrue(
                is_safe_callback_url("http://127.0.0.1:3000/api/queue/complete")
            )
            self.assertTrue(
                is_safe_callback_url("http://192.168.1.50:3000/api/queue/complete")
            )
            self.assertTrue(
                is_safe_callback_url("http://openzigs.local:3000/api/queue/complete")
            )

    def test_allows_configured_public_callback_host(self) -> None:
        """A public Cloudflare callback host is allowed only when configured."""
        with patch.dict(
            "os.environ",
            {"OPENZIGS_CALLBACK_URL": "https://primary.example.com/api/queue/complete"},
            clear=True,
        ):
            self.assertEqual(
                validate_callback_url("https://primary.example.com/api/queue/progress"),
                "https://primary.example.com/api/queue/progress",
            )

    def test_rejects_unconfigured_public_host(self) -> None:
        """Request-controlled arbitrary public hosts remain blocked."""
        with patch.dict(
            "os.environ",
            {"OPENZIGS_CALLBACK_URL": "https://primary.example.com/api/queue/complete"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "Blocked callback host"):
                validate_callback_url("https://attacker.example.net/steal")

    def test_supports_explicit_comma_allowlist(self) -> None:
        """Operators can trust multiple primary callback hosts without code edits."""
        with patch.dict(
            "os.environ",
            {
                "OPENZIGS_TRUSTED_CALLBACK_HOSTS": (
                    "https://primary.example.com/api/queue/complete, "
                    "backup.example.com:443"
                )
            },
            clear=True,
        ):
            self.assertTrue(
                is_safe_callback_url("https://primary.example.com/api/queue/complete")
            )
            self.assertTrue(
                is_safe_callback_url("https://backup.example.com/api/queue/complete")
            )
            self.assertFalse(
                is_safe_callback_url(
                    "https://evilprimary.example.com/api/queue/complete"
                )
            )


if __name__ == "__main__":
    unittest.main()