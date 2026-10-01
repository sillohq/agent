# Model behaviour: soft deletes, scopes, casts, events

## Soft deletes

Every `Model` has `deleted_at`:

```python
await post.soft_delete()        # sets deleted_at
await post.restore()
await post.delete()             # really deletes the row

await Post.active()             # deleted_at IS NULL
await Post.deleted()            # only soft-deleted
await Post.all()                # everything — soft-deleted rows included
```

`Post.all()` and `Post.filter(...)` include soft-deleted rows unless you add a global
scope:

```python
# database/models/__init__.py, after the imports
Post.add_global_scope(lambda qs: qs.filter(deleted_at__isnull=True))
await Post.without_global_scopes().all()     # bypass it
```

`SoftDeletesMixin` adds `force_delete()`, `with_trashed()`, `only_trashed()`,
`is_trashed`.

## Scopes

A classmethod named `scope_<name>(cls, queryset, *args)` becomes a chainable filter:

```python
class Post(Model):
    @classmethod
    def scope_published(cls, queryset):
        return queryset.filter(status="published")

    @classmethod
    def scope_by_author(cls, queryset, author_id):
        return queryset.filter(author_id=author_id)

await Post.published().by_author(7).order_by("-created_at").limit(10)
```

Global scopes (`Model.add_global_scope(fn)`) apply to every query on the model — useful
for tenancy (`qs.filter(tenant_id=current_tenant())`) and soft deletes.

## Casts

Transform a column on the way in and out:

```python
class Account(Model):
    preferences = fields.TextField(null=True)
    api_token = fields.TextField(null=True)
    _casts = {
        "preferences": "json",
        "api_token": ("encrypted", {"key": settings.field_key}),   # needs sillo-framework[crypto]
    }
```

Built-ins include `json`, `datetime`, `encrypted`; register your own with
`CastRegistry.register(name, encode, decode)` (`sillo.record.casting`). A cast can also
be a callable returning `(encode, decode)`.

## Model events and observers

`HasEvents` gives a model a listener registry — but **nothing in Sillo 1.0 fires these
events for you**. They run only when you call `fire_event`:

```python
from sillo.record.events import HasEvents, ModelObserver

class Order(Model, HasEvents):
    ...

@Order.on("after_create")
async def notify(order):
    await SendOrderConfirmation.dispatch(order.id)

order = await Order.create(...)
await Order.fire_event("after_create", order)     # required
```

For hooks that fire automatically on save/delete, use Tortoise's signals:

```python
from tortoise.signals import post_delete, post_save

@post_save(Order)
async def order_saved(sender, instance, created, using_db, update_fields):
    if created:
        await SendOrderConfirmation.dispatch(instance.id)

@post_delete(Order)
async def order_deleted(sender, instance, using_db):
    ...
```

Register signal handlers at import time of a module that is always imported (the models
package). Keep them fast — they run inside the request — and push slow work to a queue.

## Validation before save

```python
from sillo.record.mixins import ValidatesBeforeSaveMixin

class Invoice(Model, ValidatesBeforeSaveMixin):
    async def validate(self):
        if self.total_cents < 0:
            raise ValueError("total cannot be negative")
```

## Mass assignment

`fillable = ("name", "bio")` (allow-list) or `guarded = ("is_staff",)` (deny-list) on the
model limit what `update_from_dict` writes; `update_from_dict(data, only=[...])` narrows a
single call. Validate the payload with a Pydantic model first and pass
`payload.model_dump(exclude_unset=True)`.

## Collections

`Collection(await Post.filter(...))` gives `pluck`, `key_by`, `group_by`, `sort_by`,
`chunk`, `sum`/`avg` on an already-loaded list. Do filtering and sorting in the query
when you can; collections are for post-processing.
