---
name: sillo-cli
title: The sillo command & custom commands
description: >-
  The sillo CLI: how it finds the app, dev/routes/version, the db, user, queue and schedule commands, and custom console commands with sillo.console.
intents:
  - add a management command
  - create a command to import products from CSV
  - list the routes
  - which sillo commands are available
  - sillo command not found or db commands missing
  - run a one-off script against the database
capabilities: [cli]
related: [sillo-migrations, sillo-users, sillo-queues, sillo-scheduler, sillo-application]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.console.Command
  - sillo.console.Argument
  - sillo.console.Option
  - sillo.console.Flag
  - sillo.console.Console
  - sillo.application.SilloApp.add_command
  - sillo.application.SilloApp.command
  - sillo.dev.run_dev
probes:
  - db_commands_appear_and_migrate_round_trip
  - custom_commands_need_context_for_the_database
sources:
  - core:sillo/__main__.py
  - core:sillo/console/command.py
  - core:sillo/application.py
  - docs:v1.0/cli/index.md
  - docs:v1.0/cli/discovery.md
  - docs:v1.0/cli/custom-commands.md
  - docs:v1.0/cli/arguments.md
status: stable
---

## When

Using or extending the `sillo` command: listing routes, running the dev server, database
and account commands, queue/scheduler processes, or adding project commands (imports,
backfills, seeds, maintenance). The Python `sillo` CLI is part of `sillo-framework`; it is
unrelated to `sillo-start` (project creation) and to `sillo-agent`.

## Inspect first

`[tool.sillo] app` in `pyproject.toml`, existing `app.add_command(...)` registrations
(often `app/commands.py`), and `sillo --help` output from the project's environment.

## How

**Discovery.** `sillo` imports the application from `SILLO_APP`, then `[tool.sillo] app`,
then `app.main:app`, `main:app`, `app:app`, after loading `.env`. Pin it:

```toml
[tool.sillo]
app = "app.main:app"
```

**Commands:**

| Always | `sillo version` (features really installed), `sillo routes [--method post]`, `sillo dev [--port] [--no-reload]` |
|---|---|
| with `setup_record` | `db:init`, `db:make`, `db:migrate`, `db:plan`, `db:rollback`, `db:sql`, `db:status`; `user:create`, `user:admin`, `user:list`, `user:show`, `user:password`, `user:active`, `user:staff` |
| in a project | `queue:work`, `queue:list`, `queue:failed`, `queue:forget`, `queue:flush` (reads `QUEUE_URL`); `schedule:run`, `schedule:list`, `schedule:pause`, `schedule:resume` |

Missing `db:*`/`user:*` means the app was not found or has no database manager on
`app.state` — `sillo routes` shows which app was imported.

**Custom commands:**

```python
# app/commands.py
import csv

from sillo.console import Argument, Command, Flag

from database.config import database        # DatabaseManager factory (sillo-start layout)
from database.models import Product

class ImportProducts(Command):
    name = "products:import"
    help = "Import products from a CSV file"
    arguments = [
        Argument("path", help="CSV file"),
        Flag("dry-run", help="Validate without writing"),
    ]

    def context(self):
        return database()                    # an async context manager: connects, then closes

    async def handle(self):
        rows = list(csv.DictReader(open(self.argument("path"))))
        if self.flag("dry_run"):
            self.info(f"{len(rows)} rows would be imported")
            return
        for row in rows:
            await Product.create(name=row["name"], price_cents=int(row["price_cents"]))
        self.success(f"Imported {len(rows)} products")
```

```python
# app/main.py (or the bootstrap)
from sillo.cache import get_default_backend

from app.commands import ImportProducts

app.add_command(ImportProducts)

@app.command("cache:clear", help="Drop cached values")
async def cache_clear(cmd):
    await get_default_backend().clear()
    cmd.success("Cache cleared")
```

`arguments`: `Argument(name, default=, type=, choices=, variadic=)`,
`Option(name, short=, type=, default=, multiple=, required=)`, `Flag(name, short=)`; read
with `self.argument()`, `self.option()`, `self.flag("dry_run")`. Output helpers:
`info`, `success`, `warn`, `error`, `muted`, `bullet`, `table`, `pairs`, `progress`;
prompts: `ask`, `confirm`, `secret`, `choice`; `self.fail(msg, exit_code=)` stops.
`handle` may be async or sync. Standalone consoles (no app): `sillo.console.Console`.

No `database/config.py`? Add one exposing
`def database(): return DatabaseManager(config).register_models(...).set_migrations(...)`
(see `sillo-migrations` programmatic.md) and use it from both the bootstrap and commands —
importing `app.main` from a command module creates an import cycle.

## Compose

Database commands — `sillo-migrations`; accounts — `sillo-users`; workers and scheduler
— `sillo-queues`, `sillo-scheduler`; the dev server and deployment — `sillo-application`.

## Verify

`sillo --help` lists the command; run it against a development database; for logic, test
the service function it calls rather than the command.

## Avoid

- ORM calls in a command without `context()`: "default_connection … cannot be None".
- Relying on the conventional app paths when a stray `main.py` exists — set
  `[tool.sillo] app`.
- Running `sillo` from a different environment than the project (a global install): run
  it with `uv run sillo …` or the venv's `bin/sillo`.
- Confusing `sillo` (framework CLI), `sillo-start` (creates projects) and `sillo-agent`
  (installs these skills).
