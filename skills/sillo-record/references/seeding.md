# Factories, seeders and fixtures

## Factories (tests and demo data)

```python
from uuid import uuid4
from sillo.record.factories import Factory
from database.models import Category, Product


class CategoryFactory(Factory):
    model = Category
    definition = staticmethod(lambda: {"name": f"Category {uuid4().hex[:6]}"})


class ProductFactory(Factory):
    model = Product
    definition = staticmethod(lambda: {"name": "Lamp", "price_cents": 1999})

    @classmethod
    async def create(cls, overrides=None):
        overrides = dict(overrides or {})
        overrides.setdefault("category_id", (await CategoryFactory.create()).id)
        return await super().create(overrides)
```

```python
product = await ProductFactory.create()
products = await ProductFactory.create_many(5, {"price_cents": 500})
draft = ProductFactory.make()               # unsaved instance
```

States are subclasses whose definition overrides a few values:

```python
class SaleProductFactory(ProductFactory):
    definition = ProductFactory.state(price_cents=99)

sale = await SaleProductFactory.create()
```

`definition` must produce fresh values on each call (unique fields!), hence the lambda.

## Seeders

```python
from sillo.record.helpers import Seeder

seeder = Seeder(app.state["record"])
seeder.seed(Category, [{"name": "Lamps"}, {"name": "Chairs"}])
created = await seeder.run()
```

## Fixtures from files

```python
from sillo.record.helpers import FixtureLoader

loader = FixtureLoader("fixtures/", models={"01_categories": Category, "02_products": Product})
count = await loader.load_all()
```

## A `db:seed` command

```python
from sillo.console import Command, Flag
from sillo.record.helpers import FixtureLoader

from database.config import database


class Seed(Command):
    name = "db:seed"
    help = "Load the development dataset"
    arguments = [Flag("force", short="f", help="Run outside development")]

    def context(self):
        return database()               # connects the database for this command

    async def handle(self):
        if settings.app_env != "local" and not self.flag("force"):
            self.fail("Refusing to seed outside development. Use --force.")
        count = await FixtureLoader("fixtures/").load_all()
        self.success(f"Loaded {count} rows.")
```

Register it with `app.add_command(Seed)` so `sillo db:seed` finds it — see `sillo-cli`.
Without `context()` the command runs with no database connection. Idempotent seeds use
`upsert(..., conflict_fields=[...])` so re-running does not duplicate rows.
