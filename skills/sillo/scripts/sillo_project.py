"""Report what a coding agent needs to know about a Sillo project, as JSON.

Run it with the project's own interpreter so it sees what is actually
installed:

    .venv/bin/python <skill-dir>/scripts/sillo_project.py
    uv run python <skill-dir>/scripts/sillo_project.py

It reads package metadata and pyproject.toml only. It does not import Sillo,
the application, or anything else from the project, and it never reads .env
files, so running it has no side effects.
"""

from __future__ import annotations

import importlib.metadata as metadata
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

SUPPORTED = (1, 0)  # skills are written for >=1.0.0,<2.0.0
PACKAGES = [
    "sillo-framework",
    "sillo-inertia",
    "sillo-oauth",
    "sillo-wire",
    "sillo-graphql",
    "warder",
    "sillo-start",
    "sillo-vise",
]
# What each optional extra needs importable, as `sillo version` checks it.
FEATURES = {
    "record": "tortoise",
    "jwt": "jwt",
    "cache/redis": "redis",
    "mail templates": "jinja2",
    "crypto": "cryptography",
    "bcrypt": "bcrypt",
    "argon2": "argon2",
    "testclient": "httpx",
    "websocket server": "websockets",
    "sqlite driver": "aiosqlite",
    "postgres driver": "asyncpg",
    "mysql driver": "asyncmy",
}
DEFAULT_APPS = ("app.main:app", "main:app", "app:app")


def version_of(dist: str) -> str | None:
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        return None


def major_minor(version: str) -> tuple[int, int] | None:
    match = re.match(r"(\d+)\.(\d+)", version)
    return (int(match.group(1)), int(match.group(2))) if match else None


def find_root(start: Path) -> Path:
    for directory in (start, *start.parents):
        if (directory / "pyproject.toml").exists() or (directory / ".git").exists():
            return directory
    return start


def configured_app(root: Path) -> str | None:
    if os.environ.get("SILLO_APP"):
        return os.environ["SILLO_APP"]
    pyproject = root / "pyproject.toml"
    if not pyproject.exists():
        return None
    try:
        import tomllib  # Python 3.11+
    except ImportError:  # pragma: no cover - 3.10
        text = pyproject.read_text(encoding="utf-8")
        match = re.search(r'\[tool\.sillo\][^\[]*?\bapp\s*=\s*"([^"]+)"', text, re.S)
        return match.group(1) if match else None
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    app = data.get("tool", {}).get("sillo", {}).get("app")
    return app if isinstance(app, str) else None


def guess_app(root: Path) -> str | None:
    for candidate in DEFAULT_APPS:
        module = candidate.split(":", 1)[0]
        path = root.joinpath(*module.split("."))
        if path.with_suffix(".py").exists() or (path / "__init__.py").exists():
            return candidate
    return None


def main() -> None:
    root = find_root(Path.cwd())
    sillo = version_of("sillo-framework")
    spec = importlib.util.find_spec("sillo")
    source = str(Path(spec.origin).parent) if spec and spec.origin else None
    mm = major_minor(sillo) if sillo else None
    report = {
        "python": sys.version.split()[0],
        "interpreter": sys.executable,
        "project_root": str(root),
        "sillo_version": sillo,
        "supported_by_skills": bool(mm and mm[0] == SUPPORTED[0]),
        "sillo_source": source,
        "packages": {name: v for name in PACKAGES if (v := version_of(name))},
        "features": {
            name: importlib.util.find_spec(module) is not None
            for name, module in FEATURES.items()
        },
        "app": configured_app(root) or guess_app(root),
        "app_configured": configured_app(root) is not None,
    }
    if sillo is None:
        report["hint"] = (
            "sillo-framework is not installed for this interpreter. Use the "
            "project's virtualenv (.venv/bin/python, `uv run python`, "
            "`poetry run python`) or install dependencies first."
        )
    elif not report["supported_by_skills"]:
        report["hint"] = (
            f"Sillo {sillo} is outside the range the skills target (1.x). "
            "Read the installed source at sillo_source before using any example."
        )
    json.dump(report, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
