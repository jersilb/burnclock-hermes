"""Burnclock dashboard backend: save provider keys and refresh the badge cache.

The key material is owned by burnclock, not Hermes. This module writes only the
handful of provider variables the burnclock CLI understands into burnclock's
own keys file (``~/.config/burnclock/env`` by default), mode 0600. It never
forwards credentials from the gateway process environment and never reads any
Hermes credential store.

Only the routes below are exposed; all are mounted under
``/api/plugins/burnclock/`` by the Hermes dashboard.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

router = APIRouter()

PROVIDERS: dict[str, dict[str, str]] = {
    "deepseek": {
        "label": "DeepSeek",
        "env": "DEEPSEEK_API_KEY",
        "console": "https://platform.deepseek.com/api_keys",
        "placeholder": "sk-...",
    },
    "openrouter": {
        "label": "OpenRouter",
        "env": "OPENROUTER_API_KEY",
        "console": "https://openrouter.ai/keys",
        "placeholder": "sk-or-v1-...",
    },
    "moonshot": {
        "label": "Moonshot",
        "env": "MOONSHOT_API_KEY",
        "console": "https://platform.moonshot.ai/console/api-keys",
        "placeholder": "sk-...",
    },
    "minimax": {
        "label": "MiniMax",
        "env": "MINIMAX_API_KEY",
        "console": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
        "placeholder": "sk-...",
    },
    "fal": {
        "label": "fal",
        "env": "FAL_KEY",
        "console": "https://fal.ai/dashboard/keys",
        "placeholder": "key-id:key-secret",
    },
}

# API keys are opaque tokens. Keep the accepted alphabet deliberately narrow so
# a value cannot inject a new line, quote, shell expression, or second variable
# into the env file. No provider we support uses a character outside this set.
_KEY_RE = re.compile(r"[A-Za-z0-9._~+/=:-]{8,512}\Z")
_ENV_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


class KeyPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = Field(min_length=1, max_length=32)
    key: str = Field(min_length=8, max_length=512)
    refresh: bool = True


def _home() -> Path:
    return Path.home()


def _keys_path() -> Path:
    """Return burnclock's own keys file.

    ``BURNCLOCK_KEYS_FILE`` exists for tests and unusual installs. The normal
    location follows the same XDG rule the CLI uses.
    """
    override = os.environ.get("BURNCLOCK_KEYS_FILE", "").strip()
    if override:
        return Path(override).expanduser()
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(xdg).expanduser() if xdg else _home() / ".config"
    return base / "burnclock" / "env"


def _cache_path() -> Path:
    override = os.environ.get("BURNCLOCK_BADGE_CACHE", "").strip()
    if override:
        return Path(override).expanduser()
    xdg = os.environ.get("XDG_CACHE_HOME", "").strip()
    base = Path(xdg).expanduser() if xdg else _home() / ".cache"
    return base / "burnclock" / "badge.json"


def _unquote(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def _parse_env(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        match = _ENV_LINE_RE.match(line)
        if match:
            values[match.group(1)] = _unquote(match.group(2))
    return values


def _read_keys(path: Path) -> tuple[dict[str, str], str, int | None]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}, "", None
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Cannot read burnclock's keys file.") from exc
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        mode = None
    return _parse_env(text), text, mode


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".env.", dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def _set_key(provider_id: str, key: str) -> Path:
    meta = PROVIDERS[provider_id]
    env_name = meta["env"]
    path = _keys_path()
    if path.is_symlink():
        raise HTTPException(
            status_code=400,
            detail="burnclock's keys file is a symlink; refusing to write through it.",
        )
    try:
        _, text, _ = _read_keys(path)
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Cannot read burnclock's keys file.") from exc

    lines = text.splitlines()
    output: list[str] = []
    replaced = False
    for line in lines:
        match = _ENV_LINE_RE.match(line)
        if match and match.group(1) == env_name:
            if not replaced:
                output.append(f'{env_name}="{key}"')
                replaced = True
            # Drop duplicate assignments: the first one wins for the CLI, so a
            # duplicate stale value would be confusing.
            continue
        output.append(line)

    if not replaced:
        if output and output[-1].strip():
            output.append("")
        output.append(f'{env_name}="{key}"')

    new_text = "\n".join(output).rstrip("\n") + "\n"
    try:
        _atomic_write(path, new_text)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Cannot write burnclock's keys file.") from exc
    return path


def _mask(value: str) -> str:
    return "••••" + value[-4:] if len(value) >= 4 else "••••"


def _redact(value: str, secrets: list[str]) -> str:
    for secret in secrets:
        if secret:
            value = value.replace(secret, "[REDACTED]")
    return value


def _read_badge() -> dict[str, Any] | None:
    path = _cache_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _badge_provider(badge: dict[str, Any] | None, provider_id: str) -> dict[str, Any] | None:
    if not badge:
        return None
    rows = badge.get("providers")
    if not isinstance(rows, list):
        return None
    for row in rows:
        if isinstance(row, dict) and row.get("id") == provider_id:
            return row
    return None


def _status_for(provider_id: str, configured: bool) -> dict[str, Any] | None:
    row = _badge_provider(_read_badge(), provider_id)
    if row:
        return {
            "state": row.get("state") or row.get("status") or "UNKNOWN",
            "http_status": row.get("http_status"),
            "updated_at": row.get("updated_at"),
        }
    if not configured:
        return {"state": "EMPTY", "http_status": None, "updated_at": None}
    return None


def _safe_env(values: dict[str, str]) -> dict[str, str]:
    """Build the CLI environment from the keys file only.

    The gateway's own environment is intentionally not inherited: a provider
    variable exported by Hermes must not become burnclock's credential.
    """
    local_bin = str(_home() / ".local" / "bin")
    path_parts = [
        local_bin,
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    env = {
        "HOME": str(_home()),
        "PATH": os.pathsep.join(dict.fromkeys(path_parts)),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
    }
    # Non-secret cache override, so a custom cache stays in sync with the page.
    cache_override = os.environ.get("BURNCLOCK_BADGE_CACHE", "").strip()
    if cache_override:
        env["BURNCLOCK_BADGE_CACHE"] = cache_override
    tmpdir = os.environ.get("TMPDIR", "").strip()
    if tmpdir:
        env["TMPDIR"] = tmpdir
    for meta in PROVIDERS.values():
        value = values.get(meta["env"], "")
        if value:
            env[meta["env"]] = value
    return env


def _find_cli() -> str | None:
    candidates = [
        str(_home() / ".local" / "bin" / "burnclock"),
        "/opt/homebrew/bin/burnclock",
        "/usr/local/bin/burnclock",
    ]
    path = os.pathsep.join(
        [
            str(_home() / ".local" / "bin"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
    )
    found = shutil.which("burnclock", path=path)
    if found:
        return found
    for candidate in candidates:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _refresh() -> dict[str, Any]:
    values, _, _ = _read_keys(_keys_path())
    cli = _find_cli()
    if cli is None:
        return {
            "ran": False,
            "ok": False,
            "exit_code": None,
            "message": "burnclock was not found on this Mac. Install the CLI, then refresh again.",
            "providers": _providers_payload(values),
        }
    env = _safe_env(values)
    try:
        completed = subprocess.run(
            [cli, "badge", "--refresh"],
            cwd=str(_home()),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=45,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "ran": True,
            "ok": False,
            "exit_code": None,
            "message": "Refresh timed out after 45 seconds.",
            "providers": _providers_payload(values),
        }
    except OSError:
        return {
            "ran": False,
            "ok": False,
            "exit_code": None,
            "message": "Could not start burnclock.",
            "providers": _providers_payload(values),
        }

    secrets = [value for value in values.values() if value]
    stdout = _redact(completed.stdout.strip(), secrets)
    stderr = _redact(completed.stderr.strip(), secrets)
    line = next((part.strip() for part in stdout.splitlines() if part.strip()), "")
    if not line and stderr:
        line = next((part.strip() for part in stderr.splitlines() if part.strip()), "")
    if len(line) > 300:
        line = line[:300] + "…"
    return {
        "ran": True,
        "ok": completed.returncode == 0,
        "exit_code": completed.returncode,
        "message": line or ("Refresh finished." if completed.returncode == 0 else "Refresh failed."),
        "providers": _providers_payload(values),
    }


def _providers_payload(values: dict[str, str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for provider_id, meta in PROVIDERS.items():
        value = values.get(meta["env"], "")
        configured = bool(value)
        rows.append(
            {
                "id": provider_id,
                "label": meta["label"],
                "variable": meta["env"],
                "configured": configured,
                "masked": _mask(value) if configured else None,
                "console_url": meta["console"],
                "placeholder": meta["placeholder"],
                "status": _status_for(provider_id, configured),
            }
        )
    return rows


@router.get("/keys")
async def get_keys() -> dict[str, Any]:
    values, _, mode = _read_keys(_keys_path())
    return {
        "providers": _providers_payload(values),
        "keys_file": str(_keys_path()),
        "keys_file_mode": f"{mode:04o}" if mode is not None else None,
        "can_refresh": _find_cli() is not None,
    }


@router.post("/keys")
async def save_key(payload: KeyPayload) -> dict[str, Any]:
    provider_id = payload.provider.strip().lower()
    meta = PROVIDERS.get(provider_id)
    if meta is None:
        raise HTTPException(status_code=422, detail="Unknown provider.")
    key = payload.key.strip()
    if not _KEY_RE.fullmatch(key):
        raise HTTPException(
            status_code=422,
            detail="That does not look like an API key. Use letters, digits, and . _ ~ + / = : - only.",
        )
    path = _set_key(provider_id, key)
    refresh_result = _refresh() if payload.refresh else None
    # Re-read the file after the write so the response reflects exactly what the
    # CLI will see, even if a concurrent editor changed it.
    values, _, mode = _read_keys(path)
    return {
        "ok": True,
        "provider": provider_id,
        "masked": _mask(key),
        "keys_file_mode": f"{mode:04o}" if mode is not None else None,
        "refresh": refresh_result,
        "providers": _providers_payload(values),
    }


@router.post("/refresh")
async def refresh() -> dict[str, Any]:
    return _refresh()
