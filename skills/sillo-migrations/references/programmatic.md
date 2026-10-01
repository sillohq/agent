# Migrations from code

The `sillo db:*` commands wrap `sillo.record.commands`, which take a `DatabaseManager`.
Use them in scripts, CI and test fixtures where there is no application to discover.

```python
import asyncio

from sillo.record import DatabaseConfig, DatabaseManager, commands


def database() -> DatabaseManager:
    manager = DatabaseManager(DatabaseConfig(url="sqlite://storage/app.db", generate_schemas=False))
    return manager.register_models("database.models").set_migrations("database.migrations")


async def main() -> None:
    db = database()
    await commands.init(db)                       # idempotent
    await commands.make(db, "create_products")    # writes 000N_create_products.py
    print(await commands.plan(db))                # lines describing pending migrations
    await commands.migrate(db)                    # target=, fake= as on the CLI
    # commands.rollback(db, "0001_create_products"), commands.sql(db, "0002_x", backward=True)


asyncio.run(main())
```

The sillo-start layout keeps exactly this `database()` factory in
`database/config.py`, shared by the app and scripts, so the two can never disagree on
where models and migrations live.

## Using the ORM from a script

```python
async def main() -> None:
    db = database()
    await db.init()
    try:
        await Product.create(name="lamp")
    finally:
        await db.shutdown()          # otherwise the interpreter hangs at exit
```

## A test fixture with a migrated database

```python
import pytest

@pytest.fixture
async def migrated(tmp_path):
    db = DatabaseManager(DatabaseConfig(url=f"sqlite://{tmp_path}/test.db", generate_schemas=False))
    db.register_models("database.models").set_migrations("database.migrations")
    await commands.migrate(db)
    await db.init()
    yield db
    await db.shutdown()
```

Running the real migrations in one test catches a migration that `generate_schemas`
would paper over (such as the semicolon-in-a-comment failure).
