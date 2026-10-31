from __future__ import annotations

import importlib.util
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

MODULE_PATH = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"


def load_module():
    spec = importlib.util.spec_from_file_location("burnclock_plugin_api", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class PluginApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.keys_path = self.root / "config" / "burnclock" / "env"
        self.cache_path = self.root / "cache" / "burnclock" / "badge.json"
        self.old_keys = os.environ.get("BURNCLOCK_KEYS_FILE")
        self.old_cache = os.environ.get("BURNCLOCK_BADGE_CACHE")
        os.environ["BURNCLOCK_KEYS_FILE"] = str(self.keys_path)
        os.environ["BURNCLOCK_BADGE_CACHE"] = str(self.cache_path)
        self.api = load_module()
        app = FastAPI()
        app.include_router(self.api.router)
        self.client = TestClient(app)

    def tearDown(self):
        if self.old_keys is None:
            os.environ.pop("BURNCLOCK_KEYS_FILE", None)
        else:
            os.environ["BURNCLOCK_KEYS_FILE"] = self.old_keys
        if self.old_cache is None:
            os.environ.pop("BURNCLOCK_BADGE_CACHE", None)
        else:
            os.environ["BURNCLOCK_BADGE_CACHE"] = self.old_cache
        self.tmp.cleanup()

    def write_keys(self, text: str) -> None:
        self.keys_path.parent.mkdir(parents=True, exist_ok=True)
        self.keys_path.write_text(text, encoding="utf-8")
        os.chmod(self.keys_path, 0o600)

    def test_get_keys_masks_values_and_never_returns_secret(self):
        self.write_keys(
            "# burnclock keys\n"
            "DEEPSEEK_API_KEY=sk-deepseek-1234567890\n"
            "OPENROUTER_API_KEY='sk-or-v1-abcdefghijklmnop'\n"
        )
        response = self.client.get("/keys")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        text = response.text
        self.assertNotIn("sk-deepseek-1234567890", text)
        self.assertNotIn("sk-or-v1-abcdefghijklmnop", text)
        deepseek = next(row for row in body["providers"] if row["id"] == "deepseek")
        self.assertTrue(deepseek["configured"])
        self.assertEqual(deepseek["masked"], "••••7890")
        self.assertEqual(body["keys_file"], str(self.keys_path))
        self.assertIn(body["keys_file_mode"], {"0600"})

    def test_save_key_updates_file_with_mode_and_removes_duplicates(self):
        self.write_keys(
            "# keep this comment\n"
            "DEEPSEEK_API_KEY=old-value-0000\n"
            "DEEPSEEK_API_KEY=stale-duplicate\n"
            "OPENROUTER_API_KEY=sk-or-v1-keep-this\n"
        )
        response = self.client.post(
            "/keys",
            json={"provider": "deepseek", "key": "sk-new-deepseek-9876543210", "refresh": False},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["masked"], "••••3210")
        self.assertNotIn("sk-new-deepseek-9876543210", response.text)
        written = self.keys_path.read_text(encoding="utf-8")
        self.assertIn("# keep this comment", written)
        self.assertIn('DEEPSEEK_API_KEY="sk-new-deepseek-9876543210"', written)
        self.assertEqual(written.count("DEEPSEEK_API_KEY="), 1)
        self.assertIn("OPENROUTER_API_KEY=sk-or-v1-keep-this", written)
        self.assertEqual(stat.S_IMODE(self.keys_path.stat().st_mode), 0o600)

    def test_unsafe_key_is_rejected_without_touching_file(self):
        original = "DEEPSEEK_API_KEY=sk-existing-12345678\n"
        self.write_keys(original)
        response = self.client.post(
            "/keys",
            json={"provider": "deepseek", "key": 'sk-bad"\nINJECTED=x', "refresh": False},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.keys_path.read_text(encoding="utf-8"), original)

    def test_unknown_provider_is_rejected(self):
        response = self.client.post(
            "/keys",
            json={"provider": "not-a-provider", "key": "sk-abcdefgh", "refresh": False},
        )
        self.assertEqual(response.status_code, 422)

    def test_symlink_keys_file_is_rejected(self):
        target = self.root / "target.env"
        target.write_text("DEEPSEEK_API_KEY=sk-target-12345678\n", encoding="utf-8")
        self.keys_path.parent.mkdir(parents=True, exist_ok=True)
        self.keys_path.symlink_to(target)
        response = self.client.post(
            "/keys",
            json={"provider": "deepseek", "key": "sk-new-abcdefgh", "refresh": False},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(target.read_text(encoding="utf-8"), "DEEPSEEK_API_KEY=sk-target-12345678\n")

    def test_cli_environment_drops_parent_provider_secrets(self):
        values = {"OPENROUTER_API_KEY": "sk-from-file"}
        old = os.environ.get("DEEPSEEK_API_KEY")
        os.environ["DEEPSEEK_API_KEY"] = "parent-shell-secret-should-not-pass"
        try:
            env = self.api._safe_env(values)
        finally:
            if old is None:
                os.environ.pop("DEEPSEEK_API_KEY", None)
            else:
                os.environ["DEEPSEEK_API_KEY"] = old
        self.assertNotIn("DEEPSEEK_API_KEY", env)
        self.assertEqual(env["OPENROUTER_API_KEY"], "sk-from-file")
        self.assertNotIn("parent-shell-secret-should-not-pass", str(env))

    def test_status_uses_cached_badge(self):
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(
            '{"providers":[{"id":"deepseek","state":"KEY_REJECTED","http_status":401}]}',
            encoding="utf-8",
        )
        self.write_keys("DEEPSEEK_API_KEY=sk-deepseek-1234567890\n")
        body = self.client.get("/keys").json()
        deepseek = next(row for row in body["providers"] if row["id"] == "deepseek")
        self.assertEqual(deepseek["status"]["state"], "KEY_REJECTED")
        self.assertEqual(deepseek["status"]["http_status"], 401)

    def test_refresh_uses_file_keys_only_and_redacts_output(self):
        self.write_keys("OPENROUTER_API_KEY=sk-or-file-secret-1234\n")
        env_dump = self.root / "cli-env.txt"
        fake = self.root / "fake-burnclock"
        fake.write_text(
            "#!/bin/sh\n"
            f"env > {env_dump}\n"
            "printf 'OPENROUTER_API_KEY=%s\\n' \"$OPENROUTER_API_KEY\"\n"
            "exit 4\n",
            encoding="utf-8",
        )
        os.chmod(fake, 0o700)
        old_find = self.api._find_cli
        self.api._find_cli = lambda: str(fake)
        old = os.environ.get("DEEPSEEK_API_KEY")
        os.environ["DEEPSEEK_API_KEY"] = "parent-shell-secret-should-not-pass"
        try:
            result = self.api._refresh()
        finally:
            self.api._find_cli = old_find
            if old is None:
                os.environ.pop("DEEPSEEK_API_KEY", None)
            else:
                os.environ["DEEPSEEK_API_KEY"] = old
        self.assertTrue(result["ran"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["exit_code"], 4)
        self.assertNotIn("sk-or-file-secret-1234", result["message"])
        self.assertIn("[REDACTED]", result["message"])
        cli_env = env_dump.read_text(encoding="utf-8")
        self.assertIn("OPENROUTER_API_KEY=sk-or-file-secret-1234", cli_env)
        self.assertNotIn("DEEPSEEK_API_KEY", cli_env)
        self.assertNotIn("parent-shell-secret-should-not-pass", cli_env)


if __name__ == "__main__":
    unittest.main()
