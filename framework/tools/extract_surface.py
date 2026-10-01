"""Snapshot the public surface of an installed Sillo into JSON.

Run it with the interpreter that has the version you want to describe:

    python framework/tools/extract_surface.py > framework/surface/sillo-framework@1.0.0.json
    python framework/tools/extract_surface.py --distribution sillo-wire \
        --package sillo_wire > framework/surface/sillo-wire@1.0.0.json

The snapshot is what skill validation checks symbol references against, and
what `npm run coverage:gaps` diffs against framework/capabilities.yml. It is
produced by importing the framework, not by reading its docs, because the docs
and the code have disagreed before (the routing guide documents `app.route`,
which does not exist).

Only the standard library is used, so it runs in any Sillo environment.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import inspect
import io
import json
import pkgutil
import sys
from contextlib import redirect_stderr, redirect_stdout

# Private or internal packages whose names do not start with an underscore.
SKIP_PREFIXES = (
    "sillo.testclient._internal",
    "sillo.core.helpers",
    "sillo.handlers",
    "sillo.helpers.lazy",
    "sillo.helpers.registry",
    "sillo.middleware.bridge",
)


def _param(p: inspect.Parameter) -> str:
    # Annotations are dropped on purpose: Sillo wraps most of them in
    # Annotated[..., Doc("...")] and they would make every signature a page long.
    text = p.name
    if p.kind is inspect.Parameter.VAR_POSITIONAL:
        text = "*" + text
    elif p.kind is inspect.Parameter.VAR_KEYWORD:
        text = "**" + text
    if p.default is not inspect.Parameter.empty:
        default = p.default
        if isinstance(default, (str, int, float, bool, type(None))):
            text += "=" + repr(default)
        elif isinstance(default, (list, tuple, dict)) and not default:
            text += "=" + repr(default)
        else:
            text += "=…"
    return text


def signature_of(obj: object) -> str | None:
    target = obj.__init__ if inspect.isclass(obj) else obj  # type: ignore[misc]
    try:
        sig = inspect.signature(target)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    params = list(sig.parameters.values())
    if inspect.isclass(obj) and params and params[0].name == "self":
        params = params[1:]
    parts: list[str] = []
    seen_kwonly = False
    for p in params:
        if p.kind is inspect.Parameter.KEYWORD_ONLY and not seen_kwonly:
            if not any(q.kind is inspect.Parameter.VAR_POSITIONAL for q in params):
                parts.append("*")
            seen_kwonly = True
        parts.append(_param(p))
    return "(" + ", ".join(parts) + ")"


def kind_of(obj: object) -> str:
    if inspect.isclass(obj):
        return "class"
    if inspect.iscoroutinefunction(obj):
        return "async function"
    if inspect.isfunction(obj) or inspect.isbuiltin(obj):
        return "function"
    if inspect.ismodule(obj):
        return "module"
    return "value"


def public_names(mod: object) -> list[str]:
    names = getattr(mod, "__all__", None)
    if names is not None:
        return sorted(set(names))
    out = []
    for name, value in vars(mod).items():
        if name.startswith("_"):
            continue
        # Without __all__, only count what the module defines itself.
        if getattr(value, "__module__", None) == mod.__name__:  # type: ignore[attr-defined]
            out.append(name)
    return sorted(out)


def members_of(cls: type) -> list[str]:
    out = []
    for name, value in vars(cls).items():
        if name.startswith("_"):
            continue
        if callable(value) or isinstance(value, (property, classmethod, staticmethod)):
            out.append(name)
    return sorted(out)


def cli_commands() -> list[dict[str, str]]:
    """Every command the `sillo` console can offer, and what makes it appear.

    `requires` mirrors sillo.__main__._register_project: the framework commands
    always exist, db:* and user:* need a database manager on app.state (put
    there by setup_record), and queue:*/schedule:* are added for any project.
    """
    groups: list[tuple[str, str, object]] = [
        ("sillo.__main__", "COMMANDS", "always"),
        ("sillo.record.console", "record_commands", "setup_record"),
        ("sillo.users.console", "user_commands", "setup_record"),
        ("sillo.work.console", "work_commands", "project"),
    ]
    out: list[dict[str, str]] = []
    for module_name, attr, requires in groups:
        try:
            value = getattr(importlib.import_module(module_name), attr)
            if callable(value) and not isinstance(value, list):
                if attr == "record_commands":
                    commands = value(object())
                elif attr == "user_commands":
                    commands = value(model=None, context=None)
                else:
                    commands = value(url=None, scheduler=None, context=None)
            else:
                commands = value
        except Exception:
            continue
        for cmd in commands:
            out.append(
                {
                    "name": cmd.name,
                    "help": getattr(cmd, "help", "") or "",
                    "requires": str(requires),
                }
            )
    return sorted(out, key=lambda c: c["name"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--distribution", default="sillo-framework")
    parser.add_argument(
        "--package",
        action="append",
        help="Import package to walk (repeatable). Defaults to sillo.",
    )
    args = parser.parse_args()
    roots = args.package or ["sillo"]

    modules: dict[str, dict] = {}
    errors: dict[str, str] = {}
    names: list[str] = []
    for root in roots:
        package = importlib.import_module(root)
        names.append(root)
        if hasattr(package, "__path__"):
            names += [m.name for m in pkgutil.walk_packages(package.__path__, root + ".")]
    for name in names:
        if any(part.startswith("_") for part in name.split(".")[1:]):
            continue
        if name.startswith(SKIP_PREFIXES):
            continue
        sink = io.StringIO()
        try:
            with redirect_stdout(sink), redirect_stderr(sink):
                mod = importlib.import_module(name)
        except Exception as exc:  # an optional extra that is not installed
            errors[name] = f"{type(exc).__name__}: {exc}"[:200]
            continue
        symbols: dict[str, dict] = {}
        for sym in public_names(mod):
            value = getattr(mod, sym, None)
            if value is None and not hasattr(mod, sym):
                continue
            entry: dict[str, object] = {"kind": kind_of(value)}
            if callable(value) and not inspect.ismodule(value):
                sig = signature_of(value)
                if sig is not None:
                    entry["signature"] = sig
            if inspect.isclass(value):
                entry["members"] = members_of(value)
            symbols[sym] = entry
        modules[name] = {
            "package": hasattr(mod, "__path__"),
            "all": hasattr(mod, "__all__"),
            "symbols": symbols,
        }

    try:
        version = importlib.metadata.version(args.distribution)
    except importlib.metadata.PackageNotFoundError:
        version = getattr(importlib.import_module(roots[0]), "__version__", "unknown")
    json.dump(
        {
            "framework": "sillo",
            "distribution": args.distribution,
            "version": version,
            "python": sys.version.split()[0],
            "modules": modules,
            "unimportable": errors,
            "cli": cli_commands() if roots == ["sillo"] else [],
        },
        sys.stdout,
        indent=1,
        sort_keys=True,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
