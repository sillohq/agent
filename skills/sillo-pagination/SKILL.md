---
name: sillo-pagination
title: Pagination
description: >-
  Paging Sillo list endpoints: sillo.record.paginate for querysets, the paginate/apaginate builders with page_number, limit_offset and cursor strategies, and a safe response shape.
intents:
  - add pagination
  - paginate the products endpoint
  - return 20 items per page with a total count
  - add cursor pagination to the feed
  - limit and offset for this list
capabilities: [pagination]
related: [sillo-record, sillo-validation, sillo-responses, sillo-routing]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.record.paginate
  - sillo.record.PaginatedResult
  - sillo.paginate
  - sillo.apaginate
  - sillo.pagination.PageNumberPagination
  - sillo.pagination.LimitOffsetPagination
  - sillo.pagination.CursorPagination
  - sillo.record.pagination.TortoiseDataHandler
probes:
  - record_paginate_is_not_the_response_paginate
  - paginate_builder_shape_and_broken_links
sources:
  - core:sillo/record/queries.py
  - core:sillo/responses.py
  - core:sillo/pagination.py
  - docs:v1.0/guides/pagination.mdx
  - docs:v1.0/orm/pagination.md
status: stable
---

## When

Any list endpoint that can grow: products, orders, a feed, search results.

## Inspect first

Existing list endpoints and the page shape clients already consume (`page`/`page_size`
vs `limit`/`offset` vs cursors, key names), and whether routes declare response models.

## How

**Recommended for database lists** — page the queryset, shape the output yourself:

```python
from sillo import HttpContext, Query
from sillo.record import paginate

@router.get("/products")
async def index(
    ctx: HttpContext,
    page=Query(1, type=int, ge=1),
    per_page=Query(20, type=int, ge=1, le=100),
):
    result = await paginate(Product.active().select_related("category"),
                            page=page, page_size=per_page, ordering="-created_at")
    return {
        "items": [ProductOut.model_validate(p, from_attributes=True).model_dump() for p in result.items],
        "page": result.page,
        "per_page": result.page_size,
        "total": result.total,
        "pages": result.pages,
        "has_next": result.has_next,
    }
```

`sillo.record.paginate(queryset, page=, page_size=, ordering=)` runs one count and one
page query and returns a `PaginatedResult` (`items`, `total`, `page`, `page_size`,
`pages`, `has_next`, `has_prev`, `to_dict()`). Validate `page`/`per_page` with markers and
cap the size.

**The response builders** (`from sillo import paginate, apaginate`) take the context
first and read the query string themselves:

```python
return paginate(ctx, items_list, strategy="page_number")          # ?page=&page_size=
return paginate(ctx, items_list, strategy="limit_offset")         # ?limit=&offset=
return await apaginate(ctx, Product.all().order_by("id"), data_handler=TortoiseDataHandler)
```

They return `{"items": [...], "pagination": {"total_items", "total_pages", "page",
"page_size", "links": {...}}}`. `strategy` also accepts a configured instance —
`PageNumberPagination(default_page_size=20, max_page_size=100)`,
`LimitOffsetPagination(...)`, `CursorPagination(sort_field="id")`.

## Compose

Query building — `sillo-record`. Parameter validation — `sillo-validation`. Output
schemas — `sillo-validation` (`response_model`) or explicit `model_dump()`.

## Verify

Test page 1, a middle page, the last page, an out-of-range page, and `per_page` above the
cap (422 when validated with `le=`). Assert `total` against the fixture count.

## Avoid

- `from sillo import paginate` for a queryset: that is the HTTP builder (it takes `ctx`
  and a list). The queryset helper is `sillo.record.paginate`.
- Trusting the builders' `links` in sillo-framework 1.0.0: they append `?page=…` to a URL
  that already has a query string (`/list?page=2?page=3`). Return page numbers, or build
  links with `ctx.url_for`.
- `apaginate` with `TortoiseDataHandler` for public APIs: it serialises every model field
  (timestamps, internal columns). Shape items explicitly.
- Unbounded `page_size` from the client; `offset` paging on huge tables where a cursor
  (`id > last_id`) is cheaper.
