# Querying

Record querysets are Tortoise querysets. All of this is `await`-ed.

## Basics

```python
await Product.all()
await Product.get(id=1)                    # raises DoesNotExist
await Product.get_or_none(id=1)            # None instead
await Product.filter(price_cents__gte=1000, category_id=3).order_by("-created_at").limit(10).offset(20)
await Product.exclude(status="archived")
await Product.filter(name__icontains="lamp").exists()
await Product.filter(category_id=3).count()
await Product.filter(id__in=[1, 2, 3])
await Product.all().values("id", "name")               # dicts
await Product.all().values_list("id", flat=True)       # scalars
await Product.first()                                  # queryset.first() too
```

Lookups: `exact`, `iexact`, `contains`, `icontains`, `startswith`, `endswith`, `in`,
`gt`, `gte`, `lt`, `lte`, `range`, `isnull`, `not`, plus `field__related__field` across
relations (`Product.filter(category__name="Lamps")`).

## Expressions

```python
from tortoise.expressions import F, Q
from tortoise.functions import Count, Sum

await Product.filter(Q(status="published") | Q(featured=True))
await Product.filter(~Q(status="archived"))
await Product.filter(id=pid).update(views=F("views") + 1)            # atomic
await Category.annotate(n=Count("products")).filter(n__gt=0).order_by("-n")
await Order.filter(user_id=uid).annotate(total=Sum("amount_cents")).values("total")
```

Build optional filters with `Q()` accumulation:

```python
query = Q()
if term:
    query &= Q(name__icontains=term)
if category_id:
    query &= Q(category_id=category_id)
products = await Product.filter(query)
```

## Eager loading

```python
await Post.all().select_related("author")                  # FK/O2O, one joined query
await Post.all().prefetch_related("tags", "comments")      # reverse FK / M2M, extra queries
await post.fetch_related("author", "tags")                 # one instance

from tortoise.query_utils import Prefetch
await Author.all().prefetch_related(
    Prefetch("posts", queryset=Post.filter(status="published"), to_attr="published_posts")
)
```

Accessing an unfetched relation in a loop is the N+1 query problem — fetch first.

## Writes

```python
product = await Product.create(name="Lamp", price_cents=1999, category=cat)
product.price_cents = 2499
await product.save(update_fields=["price_cents"])
await Product.filter(category_id=3).update(status="archived")   # returns the row count
await Product.filter(id=pid).delete()
await Product.bulk_create([Product(name=n, category=cat) for n in names], batch_size=500)
await Setting.upsert(key="theme", value="dark", conflict_fields=["key"])
```

Update-or-create safely:

```python
setting = await Setting.get_or_none(key="theme")
if setting is None:
    setting = await Setting.create(key="theme", value="dark")
else:
    await setting.update_from_dict({"value": "dark"})
    await setting.save()
```

## Helpers in `sillo.record`

```python
from sillo.record import paginate, iter_all, count_by, find_by_ids, explain

page = await paginate(Product.active(), page=2, page_size=20, ordering="-created_at")
page.items, page.total, page.pages, page.has_next, page.to_dict()

async for product in iter_all(Product.all(), batch_size=500):   # streams in batches
    ...
await count_by(Order.all(), "status")          # {"paid": 12, "pending": 3}
await find_by_ids(Product.all(), [3, 7, 11])   # unordered
print(await explain(Product.filter(category_id=3)))
```

## Raw SQL

```python
from tortoise import connections

rows = await connections.get("default").execute_query_dict(
    "SELECT status, COUNT(*) AS n FROM orders WHERE user_id = $1 GROUP BY status", [user_id]
)
```

Always pass parameters; never format user input into SQL (placeholders are `$1` on
Postgres, `?` on SQLite/MySQL).

## Money and decimals

Store money as integer cents, or `DecimalField`. SQLite may return a Decimal in exponent
form (`6.7E+2`); format for display with `format(value, "f")`.
