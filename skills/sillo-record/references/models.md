# Models, fields and relationships

## The base class

`sillo.record.Model` is a Tortoise model with extras. Every subclass gets:

| Column / method | |
|---|---|
| `id` | auto integer primary key unless you declare one |
| `created_at`, `updated_at` | set automatically (UTC) |
| `deleted_at` | `None` until `soft_delete()` |
| `to_dict(include=, exclude=, max_depth=)`, `to_json()` | serialisation |
| `get_or_none(**filters)`, `get_or_create(defaults=, **filters)` | lookups |
| `upsert(conflict_fields=[...], **values)`, `bulk_upsert(rows, conflict_fields=, update_fields=)` | upserts |
| `bulk_create(rows, batch_size=)` | inserts |
| `soft_delete()`, `restore()`, `Model.active()`, `Model.deleted()` | soft deletes |
| `await obj.update_from_dict(data)` | assign (a coroutine; then `await obj.save()`) |

## Fields

Tortoise fields (`from tortoise import fields`): `CharField(max_length=)`, `TextField`,
`IntField`, `BigIntField`, `SmallIntField`, `FloatField`,
`DecimalField(max_digits=, decimal_places=)`, `BooleanField`, `DateField`,
`DatetimeField(auto_now=, auto_now_add=)`, `TimeDeltaField`, `JSONField`, `UUIDField`,
`BinaryField`, `CharEnumField(EnumType)`, `IntEnumField(EnumType)`. Common options:
`null=True`, `default=`, `unique=True`, `db_index=True`, `description=`.

Sillo's own (`from sillo.record.fields import …`):

| Field | |
|---|---|
| `PasswordField()` | hashes on the way to the database; verify with `check_password`/`verify_password` |
| `SlugField(source_field="title")` | fills a slug from another field |
| `ULIDField()` | ULID primary key (with `HasUlidMixin`) |
| `CreatedAtField`, `UpdatedAtField`, `SoftDeleteField` | what the base class uses |

## Relationships

```python
class Post(Model):
    author = fields.ForeignKeyField("models.Author", related_name="posts",
                                    on_delete=fields.CASCADE)
    tags = fields.ManyToManyField("models.Tag", related_name="posts")
    editor = fields.ForeignKeyField("models.User", related_name="edited_posts",
                                    null=True, on_delete=fields.SET_NULL)

class Profile(Model):
    user = fields.OneToOneField("models.User", related_name="profile")
```

- The reference is `"<app label>.<Class>"`; the app label is `models`.
- `post.author_id` is the raw column (no query). `post.author` needs
  `await post.fetch_related("author")` or a `select_related("author")` query.
- Reverse relations (`author.posts`) are querysets: `await author.posts.filter(...)`.
- Many-to-many: `await post.tags.add(tag)`, `.remove(tag)`, `.clear()`.
- Two foreign keys to the same model need distinct `related_name`s.
- Self-reference: `fields.ForeignKeyField("models.Category", related_name="children", null=True)`.
- `on_delete`: `CASCADE` (default), `RESTRICT`, `SET_NULL` (needs `null=True`), `SET_DEFAULT`, `NO_ACTION`.

## Meta

```python
class Meta:
    table = "posts"
    ordering = ["-created_at"]
    unique_together = (("author", "slug"),)
    indexes = (("status", "created_at"),)
```

## Registering models

```python
# database/models/__init__.py
from database.models.category import Category
from database.models.product import Product
from database.models.tag import Tag

__models__ = [Category, Product, Tag]
```

Tortoise discovers models by importing the modules named in `model_modules`; a package
with `__models__` is read from that list. For a single-file app pass the module's own
name: `setup_record(app, config, model_modules=[__name__])`.

## Field comments become SQL

A `#:` comment directly above a field becomes the column's `description`, which is
written into the DDL. Keep semicolons out of it — see `sillo-migrations`.

## Pydantic schemas from models

```python
from sillo.record.pydantic import pydantic_model_from_tortoise

ProductOut = pydantic_model_from_tortoise(Product, name="ProductOut",
                                          exclude=["deleted_at"])
```

Handwritten Pydantic models are clearer for public APIs; generated ones are convenient
for internal endpoints.
