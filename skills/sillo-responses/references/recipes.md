# Response recipes

## CSV export, streamed

```python
from sillo import HttpContext, stream

@app.get("/exports/orders.csv")
async def export_orders(ctx: HttpContext):
    async def rows():
        yield "id,total,status\n"
        async for order in Order.all().order_by("id"):
            yield f"{order.id},{order.total},{order.status}\n"

    return stream(rows(), content_type="text/csv").set_header(
        "Content-Disposition", 'attachment; filename="orders.csv"', override=True
    )
```

## NDJSON

```python
from sillo import HttpContext, ndjson

@app.get("/events.ndjson")
async def events(ctx: HttpContext):
    async def source():
        async for event in Event.all():
            yield event.to_dict()            # datetimes are encoded for you
    return ndjson(source())
```

## Files

```python
from sillo import HttpContext, download, file

@app.get("/reports/{name:slug}.pdf")
async def report(ctx: HttpContext, name: str):
    return file(f"storage/reports/{name}.pdf")                 # inline, with Range support

@app.get("/invoices/{invoice_id:int}/download")
async def invoice(ctx: HttpContext, invoice_id: int):
    path = await invoice_path_for(ctx.user, invoice_id)        # never trust a raw path param
    return download(path, f"invoice-{invoice_id}.pdf")
```

Build file paths from identifiers you looked up, not from user input; a `{name:path}`
parameter joined to a directory is a path-traversal hole. Files stored in buckets are
served through `sillo-storage` instead.

## Status codes

```python
from sillo import accepted, json, no_content
from sillo.http.status import HTTP_409_CONFLICT

return accepted({"job_id": job_id})                       # 202: queued, not done
return no_content()                                       # 204 after a delete
return json({"detail": "Email already registered"}, status_code=HTTP_409_CONFLICT)
```

Pick deliberately: 409 for a conflict with current state, 422 for an invalid value, 503
(with `Retry-After`) for a temporary outage.

## Cookies

```python
from sillo import HttpContext, json

@app.post("/preferences")
async def preferences(ctx: HttpContext):
    theme = (await ctx.json)["theme"]
    return json({"theme": theme}).set_cookie(
        "theme", theme, max_age=365 * 86400, samesite="lax", secure=ctx.is_secure
    )

@app.post("/logout-marker")
async def clear(ctx: HttpContext):
    return json({"ok": True}).delete_cookie("theme")
```

Session cookies are managed by `SessionMiddleware` (`sillo-sessions`); do not set them
by hand.

## A custom response class

```python
from sillo.responses import BaseResponse

class MsgPackResponse(BaseResponse):
    def __init__(self, content, **kwargs):
        super().__init__(body=msgpack.packb(content), content_type="application/msgpack", **kwargs)
```

## Custom JSON encoding

```python
from decimal import Decimal
from sillo.encoding import register_encoder

register_encoder(Money, lambda m: {"amount": format(m.amount, "f"), "currency": m.currency})
```

Register once at import time (e.g. in the module that defines the type). `Decimal` is
already encoded as a number; SQLite may hand Decimals back in exponent form
(`6.7E+2`), so format money explicitly with `format(value, "f")` when it must render as
written.
