---
name: sillo-application
title: Application setup & lifecycle
description: >-
  Creating and wiring a SilloApp: settings with sillo.config, .env loading, startup/shutdown
  hooks and lifespan, app.state, installables, debug mode, running locally and deploying.
intents:
  - set up a new Sillo app
  - add settings from environment variables
  - load config from .env
  - run something on startup
  - close the connection pool on shutdown
  - deploy this Sillo app to production
  - run the app locally with reload
  - where should I put app-wide objects
capabilities: [application, configuration, environment, installables, deployment]
related: [sillo-routing, sillo-middleware, sillo-record, sillo-testing, sillo-cli]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.SilloApp
  - sillo.application.SilloApp.on_startup
  - sillo.application.SilloApp.on_shutdown
  - sillo.application.SilloApp.install
  - sillo.application.SilloApp.installations
  - sillo.application.SilloApp.run
  - sillo.config.Config
  - sillo.config.Field
  - sillo.env.env
  - sillo.env.load_env
  - sillo.env.find_env
  - sillo.installables.Installable
probes:
  - lifespan_replaces_on_startup_hooks
  - testclient_runs_lifespan_only_as_context_manager
  - shutdown_hooks_run_in_registration_order
  - debug_defaults_off
sources:
  - core:sillo/application.py
  - core:sillo/installables.py
  - core:sillo/config/core.py
  - core:sillo/env/__init__.py
  - docs:v1.0/guides/startups-and-shutdowns.mdx
  - docs:v1.0/guides/configuration.md
  - docs:v1.0/guides/environment.md
  - docs:v1.0/advanced/installables.mdx
  - docs:v1.0/guides/start/deployment.md
status: stable
---

## When

Anything about the application object itself: constructing `SilloApp`, reading settings,
`.env`, work that runs once at startup or shutdown, sharing process-wide objects,
installing a subsystem, running the server, and deployment. For wiring a specific
subsystem (database, mail, queues) also load that subsystem's skill.

## Inspect first

- The application factory: `app/main.py`, `app/bootstrap.py` (the sillo-start layout has
  `create_app()` there), or whatever `[tool.sillo] app` in `pyproject.toml` names.
- Existing settings: an `app/config.py` with a `Config` subclass, and `.env.example`.
  Read `.env.example`, not `.env` — `.env` holds secrets.
- Whether the app passes `lifespan=` to `SilloApp` (see Avoid) and what is already
  registered with `on_startup` / `on_shutdown` / `setup_*`.

## How

**The application.**

```python
from sillo import SilloApp

app = SilloApp(
    title="Orders API",       # also the OpenAPI title
    version="1.0.0",
    debug=settings.debug,     # off by default; never on in production
)
```

Useful constructor arguments: `debug`, `title`/`version`/`description` (OpenAPI),
`docs=[...]` (API docs UIs, see `sillo-openapi`), `strict_validation=True` (recommended
for new apps, see `sillo-validation`), `root_path="/api"` (served under a proxy prefix),
`force_https=True` (308 to https; honours `X-Forwarded-Proto`), `trailing_slash=`,
`route_order=`, `auth=[backends]` (see `sillo-auth`), `lifespan=`.

**Settings.** `sillo.config.Config` is a Pydantic settings class. Constructing it (or a
`SilloApp`) loads the project's `.env` automatically — no python-dotenv, no
`load_dotenv()`:

```python
from sillo.config import Config, Field

class Settings(Config):
    database_url: str = "sqlite://storage/app.db"
    secret_key: str = Field(..., description="Signs sessions and CSRF tokens")
    debug: bool = False

    class Env:                       # optional
        env_prefix = "APP_"          # APP_DEBUG, APP_SECRET_KEY, …
        env_file = ".env"            # None loads no file

settings = Settings()
```

Precedence: constructor arguments > the real environment > `.env`. Secrets are masked in
`repr`. For a single value, `from sillo.env import env` then `env("PORT", 8000, cast=int)`
(`cast=bool` understands true/yes/on/1). `SILLO_ENV_FILE=.env.production` switches the
file; `SILLO_ENV_FILE=` (empty) disables auto-loading, which is what tests want.

**Startup and shutdown.**

```python
@app.on_startup
async def open_pool():
    app.state["myapp.http"] = await build_client()

@app.on_shutdown
async def close_pool():
    await app.state["myapp.http"].aclose()
```

Startup hooks run in registration order before the first request; shutdown hooks also
run in **registration order** (not reversed). A raising startup hook stops the server
from starting. `app.state` is a plain dict for process-wide objects (namespace the keys);
`ctx.state` is per request. Hooks run once per worker process.

**Installables.** Subsystems install as objects that register their own hooks and state;
`app.install()` is idempotent by `name` and returns the installed service:

```python
from sillo.record import DatabaseConfig, Record
from sillo.mail import Mail, MailConfig

database = app.install(Record(DatabaseConfig.from_env(), model_modules=["database.models"]))
mail = app.install(Mail(MailConfig()))
```

`setup_record`, `setup_mail`, `setup_storage`, `setup_work` and `setup_scheduler` are
equivalent function forms; both are fine. A custom installable is any object with a
`name` and `install(app) -> service`.

**Running.** `sillo dev` (discovers the app, reloads on change, compact request log;
`--host`, `--port`, `--no-reload`, `--reload-dir`). In production run the ASGI server
directly: `uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4` behind a reverse
proxy, with migrations as a separate release step. `app.run(host=, port=, reload=)`
exists for `python -m` style scripts. Details and a container/systemd recipe:
[deployment.md](references/deployment.md).

## Compose

- Database, mail, storage, queues and the scheduler each install onto the app — see
  `sillo-record`, `sillo-mail`, `sillo-storage`, `sillo-queues`, `sillo-scheduler`.
- Middleware and its order: `sillo-middleware`. Auth wiring: `sillo-auth`.
- The `sillo` CLI discovers this app (`SILLO_APP`, `[tool.sillo] app`, then
  `app.main:app`, `main:app`, `app:app`): `sillo-cli`.
- Tests must run the lifespan: `sillo-testing`.

## Verify

- `python -c "import app.main"` (or the configured module) imports cleanly.
- `sillo routes` lists routes from the app you expect; if it lists the wrong ones, set
  `[tool.sillo] app = "app.main:app"`.
- In tests, `with TestClient(app) as client:` — startup hooks and `setup_*` wiring only
  run inside the `with` block. Assert on `app.state` there.
- `sillo dev` starts and serves `/docs` (unless docs were disabled).

## Avoid

- Passing `lifespan=` and also using `@app.on_startup` or any `setup_*`/`app.install`:
  a lifespan **replaces** the hook list, so the database never connects and the
  scheduler never starts, silently. Use hooks, or call `await app._startup()` /
  `await app._shutdown()` inside the lifespan.
- `debug=True` in production: it serves the full debug page with source to anyone who
  finds a 500.
- Running migrations or one-time seeds in a startup hook: every worker process runs it.
- Reading `.env` yourself or adding python-dotenv — Sillo already loads it.
- `from sillo import silloApp`: the class is `SilloApp`.
- `uvicorn app:app --reload` in production; `--workers N` with SQLite (lock contention).
