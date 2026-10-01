---
name: sillo-migrations
title: Migrations
description: >-
  Changing a Sillo database schema: sillo db:init, db:make, db:plan, db:migrate, db:rollback,
  db:sql and db:status, generate_schemas, reviewing generated migrations, and debugging a
  failed migration.
intents:
  - add a migration for the new model
  - add a column to the products table
  - my migration failed
  - roll back the last migration
  - show the SQL a migration will run
  - table already exists when I migrate
  - set up migrations in this project
capabilities: [migrations]
related: [sillo-record, sillo-cli, sillo-application, sillo-debugging]
requires: [sillo-record]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework[record]"]
symbols:
  - sillo.record.MigrationHelper
  - sillo.record.DatabaseManager
  - sillo.record.commands.migrate
  - sillo.record.commands.make
  - sillo.record.commands.rollback
  - sillo.record.console.record_commands
probes:
  - db_commands_appear_and_migrate_round_trip
  - semicolon_in_field_comment_breaks_migrate
  - generate_schemas_defaults_on_and_session_cookie_secure_defaults_on
  - setup_record_puts_manager_on_app_state
sources:
  - core:sillo/record/console.py
  - core:sillo/record/helpers.py
  - core:sillo/record/manager.py
  - core:sillo/record/config.py
  - docs:v1.0/cli/database.md
  - docs:v1.0/orm/migrations.md
  - probe:framework/probes/test_migrations.py
status: stable
---

## When

The schema has to change on a real database: a new model, a new or changed field, an
index, a relation. Also "migrations are not detected", "table already exists", or a
migration that fails to apply.

## Inspect first

- `database/migrations/` — existing migrations and their numbering.
- The database wiring: `set_migrations("database.migrations")` (the default package)
  and `DatabaseConfig(generate_schemas=...)` / `DB_GENERATE_SCHEMAS`.
- That the `sillo` CLI finds the app: `sillo --help` must list `db:*` commands. They only
  appear when the application puts its database manager on `app.state`
  (`setup_record`/`Record`), found via `[tool.sillo] app` or `app.main:app`.

## How

The workflow, from the project root with the project's environment (`uv run sillo …`):

```bash
sillo db:init                     # once: creates the migrations package
sillo db:make add_price           # diff models vs. last migration → 000N_add_price.py
sillo db:sql 0002_add_price       # read the SQL before running it
sillo db:plan                     # what would run
sillo db:migrate                  # apply everything pending
sillo db:status                   # pending count; "Up to date."
```

- `db:make` writes nothing (and says "No model changes to record.") when models match.
  `--apply` migrates immediately; prefer reviewing first — a rename is generated as
  drop + add, which loses data. Edit the generated file when needed.
- `db:migrate --target 0003_x` stops at a migration; `--fake` records migrations as
  applied without running SQL (only for adopting an existing schema).
- `db:rollback 0002_add_users` unapplies everything after that migration;
  `db:rollback zero` unapplies all and asks you to type `zero` (`--force` skips the
  prompt, for CI). There is no "back one step" — name the target.

Migrations are Tortoise-native (`from tortoise import migrations`); files contain
`ops.CreateModel`, `ops.AddField`, … and can be edited like any Python.

**Turn schema generation off** once a project has migrations:

```python
DatabaseConfig(url=settings.database_url, generate_schemas=False)
```

or `DB_GENERATE_SCHEMAS=false`. With it on (the default), the app creates tables at
startup outside the migration history and the next `db:migrate` fails with "table
already exists".

**Scripts and CI** can drive migrations without the app; see
[programmatic.md](references/programmatic.md). Production: run `sillo db:migrate` once
per release (a release step or init container), never from a startup hook.

## Compose

- Model definitions: `sillo-record`. Custom `db:*`-style commands (seeding): `sillo-cli`.
- Deploy-time migration: `sillo-application`. A failing migration: `sillo-debugging`.

## Verify

`sillo db:status` → "Up to date."; then run the test suite against a migrated database
(or a test that runs the migrations on a fresh SQLite file) and exercise the new
columns through the API.

## Avoid

- A semicolon in a field's `#:` doc comment: the comment becomes an SQL column comment,
  the DDL is split on `;`, and `db:migrate` dies with `OperationalError: … incomplete
  input`. Check `db:sql` output for comments; rewrite the comment without `;`.
- Leaving `generate_schemas` on with migrations ("table already exists").
- `--fake` to get past a failing migration: it desynchronises history and schema.
- Deleting `storage/app.db` without `app.db-wal`/`app.db-shm`: SQLite replays the WAL,
  resurrecting a half-applied migration.
- Migrating from app startup or from every worker/replica at once.
- Hand-writing `CREATE TABLE` alongside migrations, or editing a migration that already
  ran elsewhere — add a new one instead.
