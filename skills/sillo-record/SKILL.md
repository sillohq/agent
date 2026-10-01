---
name: sillo-record
title: Record ORM (models & queries)
description: >-
  Sillo's Record ORM on Tortoise: database setup, defining models, fields and relationships,
  querying and eager loading, scopes, casts, soft deletes, transactions, bulk writes,
  model events, factories and seeders.
intents:
  - create Product and Category models with relationships
  - add a model for orders
  - connect the app to Postgres
  - query the published posts with their authors
  - wrap these writes in a transaction
  - soft delete records instead of removing them
  - seed the database with test data
  - count orders by status
capabilities: [database, models, querying, model_events, transactions, factories_seeding]
related: [sillo-migrations, sillo-pagination, sillo-validation, sillo-users, sillo-testing]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework[record]", "aiosqlite | asyncpg | asyncmy"]
symbols:
  - sillo.record.Model
  - sillo.record.DatabaseConfig
  - sillo.record.DatabaseManager
  - sillo.record.Record
  - sillo.record.setup_record
  - sillo.record.transaction
  - sillo.record.paginate
  - sillo.record.fields.PasswordField
  - sillo.record.fields.SlugField
  - sillo.record.fields.ULIDField
  - sillo.record.events.HasEvents
  - sillo.record.events.ModelObserver
  - sillo.record.factories.Factory
  - sillo.record.helpers.Seeder
  - sillo.record.helpers.FixtureLoader
  - sillo.record.Collection
  - sillo.record.pydantic.pydantic_model_from_tortoise
  - sillo.record.models.Model.to_dict
  - sillo.record.models.Model.get_or_none
  - sillo.record.models.Model.upsert
probes:
  - model_has_timestamps_and_soft_delete_columns
  - relations_need_fetching_and_select_related_loads_them
  - scopes_and_casts
  - has_events_listeners_only_fire_when_fired_by_hand
  - tortoise_signals_fire_automatically
  - update_from_dict_is_a_coroutine_and_update_or_create_update_path
  - record_paginate_is_not_the_response_paginate
  - transaction_rolls_back_on_error
  - to_dict_includes_timestamps
  - factory_create_and_make
  - setup_record_puts_manager_on_app_state
  - setup_record_must_come_after_auth_middleware
sources:
  - core:sillo/record/models.py
  - core:sillo/record/manager.py
  - core:sillo/record/config.py
  - core:sillo/record/events.py
  - core:sillo/record/queries.py
  - core:sillo/record/transactions.py
  - docs:v1.0/orm/setup.mdx
  - docs:v1.0/orm/models.md
  - docs:v1.0/orm/relationships.md
  - docs:v1.0/orm/queries.md
status: stable
---

## When

Anything that stores or reads application data: connecting a database, adding or
changing models, relationships, queries, transactions, soft deletes, seed data. Schema
changes on an existing database also need `sillo-migrations`.

## Inspect first

- The database wiring: `setup_record(...)` or `app.install(Record(...))` in the
  bootstrap, and the project's `database/config.py` if it has one (sillo-start layout:
  `MODEL_MODULES`, `MIGRATIONS_MODULE`, `database_config()`).
- `database/models/__init__.py`: models must be imported there (and listed in
  `__models__` when the package uses one) or they do not exist to the ORM.
- Existing models for conventions: table names, id types, `to_dict` usage, mixins.
- Whether the project already has migrations (`database/migrations/`), which decides
  `generate_schemas`.

## How

**Setup.** Install the extra and a driver (`sillo-framework[record]` plus `aiosqlite`,
`asyncpg` or `asyncmy`), then wire it — **after** the auth/session `app.use(...)` calls,
because it adds its own per-request middleware that must be outermost:

```python
from sillo.record import DatabaseConfig, setup_record

db = setup_record(
    app,
    DatabaseConfig(url=settings.database_url, generate_schemas=False),  # False once you migrate
    model_modules=["database.models"],
)
db.set_migrations("database.migrations")
```

`DatabaseConfig.from_env()` reads `DATABASE_URL`; `DatabaseConfig.sqlite("storage/app.db")`
and `DatabaseConfig.postgres("db", "password", host=…)` build one directly. The manager
lands on `app.state["record"]` (the `sillo db:*` commands need it) and connects/closes
with the app.

**Models.** Subclass `sillo.record.Model`; fields come from Tortoise. Every model gets
`created_at`, `updated_at` and `deleted_at`, `to_dict()`/`to_json()`, soft deletes,
scopes and casts:

```python
from sillo.record import Model
from sillo.record.fields import SlugField
from tortoise import fields

class Category(Model):
    name = fields.CharField(max_length=100, unique=True)

    class Meta:
        table = "categories"

class Product(Model):
    name = fields.CharField(max_length=200)
    slug = SlugField(source_field="name")
    price_cents = fields.IntField()
    category = fields.ForeignKeyField("models.Category", related_name="products")
    tags = fields.ManyToManyField("models.Tag", related_name="products")

    class Meta:
        table = "products"
```

Relations are addressed as `"models.<Class>"`. Add the import to
`database/models/__init__.py` (and `__models__`). Field types, relationship options and
the Sillo fields (`PasswordField`, `SlugField`, `ULIDField`, …):
[models.md](references/models.md).

**Queries** are Tortoise querysets on the model:

```python
product = await Product.get_or_none(id=product_id)
cheap = await Product.filter(price_cents__lt=1000).order_by("name").limit(20)
listing = await Product.active().select_related("category").prefetch_related("tags")
await product.fetch_related("tags")          # load relations on one instance
count = await Product.filter(category_id=cat.id).count()
```

A related object is **not loaded** until you fetch it (`select_related`,
`prefetch_related`, `fetch_related`); `product.category_id` is always there without a
query. Filters, `Q`/`F`, aggregates, bulk writes, pagination helpers:
[queries.md](references/queries.md).

**Transactions:**

```python
from sillo.record import transaction

async with transaction() as tx:
    order = await Order.create(...)
    async with tx.savepoint():            # optional nested rollback point
        await Payment.create(order=order, ...)
```

Soft deletes, scopes, casts, mass assignment, model events and observers:
[behaviour.md](references/behaviour.md). Factories, seeders and fixtures:
[seeding.md](references/seeding.md).

## Compose

- Schema changes: `sillo-migrations`. List endpoints: `sillo-pagination`.
- Request/response schemas from models (`pydantic_model_from_tortoise`) —
  `sillo-validation`.
- User models are special: `sillo-users`. Test databases: `sillo-testing`.
- Side effects after saves belong in queued jobs — `sillo-queues`.

## Verify

- A request (or test) that creates and reads the new model; `TestClient` must be used as
  a context manager so the database connects.
- `sillo db:make` produces the migration you expect (then `sillo db:sql <name>` to read
  it) — see `sillo-migrations`.
- For queries over relations, assert the related data is present (not a lazy relation).

## Avoid

- A model not imported in `database/models/__init__.py` → the first query fails with
  "default_connection for the model … cannot be None".
- Adding `sillo.users` to `model_modules`: its `User` displaces the project's own.
- `setup_record` before the auth/session `app.use(...)` lines: users fail to load (401s,
  "No TortoiseContext is currently active" in the log).
- `Model.update_or_create(...)` when the row exists: the update path fails in 1.0. Fetch,
  then `await obj.update_from_dict(data)` (a coroutine) and `await obj.save()`.
- `from sillo import paginate` for querysets: that is the HTTP response builder. The ORM
  helper is `from sillo.record import paginate`.
- Expecting `@Model.on("after_create")` (HasEvents) to fire by itself: nothing fires it.
  Use Tortoise signals (`tortoise.signals.post_save`) or call `fire_event` yourself.
- `generate_schemas=True` (the default) alongside migrations: tables appear outside the
  migration history and the first `db:migrate` fails.
- `post.views += 1; await post.save()` for counters: race. Use
  `await Post.filter(id=pid).update(views=F("views") + 1)`.
