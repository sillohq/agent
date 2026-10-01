---
name: sillo-responses
title: Responses
description: >-
  Sending responses in Sillo: returned values, json/html/text/xml builders, status, headers, cookies, redirects, downloads, streaming, NDJSON, SSE, Cache-Control.
intents:
  - return a 201 with the created item
  - set a cookie in the response
  - add a custom header to the response
  - return an HTML page
  - let the user download a CSV file
  - stream the export as it is generated
  - push live updates with server-sent events
  - redirect after the form is submitted
capabilities: [responses, cookies_headers]
related: [sillo-routing, sillo-validation, sillo-errors, sillo-pagination]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.json
  - sillo.html
  - sillo.text
  - sillo.xml
  - sillo.raw
  - sillo.empty
  - sillo.created
  - sillo.accepted
  - sillo.no_content
  - sillo.redirect
  - sillo.see_other
  - sillo.permanent_redirect
  - sillo.temporary_redirect
  - sillo.file
  - sillo.download
  - sillo.stream
  - sillo.ndjson
  - sillo.sse
  - sillo.abort
  - sillo.not_found
  - sillo.core.http.response.BaseResponse.set_cookie
  - sillo.core.http.response.BaseResponse.set_header
  - sillo.core.http.response.BaseResponse.cache
  - sillo.core.http.response.BaseResponse.no_cache
  - sillo.core.http.response.BaseResponse.delete_cookie
  - sillo.encoding.register_encoder
  - sillo.http.sse.ServerSentEvent
probes:
  - handler_returns_plain_value_as_json
  - returned_string_is_text_plain_not_html
  - status_shorthand_builders
  - abort_raises_and_body_is_detail
  - response_model_filters_returned_dict_but_not_built_response
sources:
  - core:sillo/responses.py
  - core:sillo/core/http/response.py
  - core:sillo/encoding.py
  - core:sillo/http/sse.py
  - docs:v1.0/guides/sending-responses.mdx
  - docs:v1.0/guides/streaming-response.mdx
  - docs:v1.0/guides/cookies.mdx
status: stable
---

## When

Deciding what a handler sends back: a status other than 200, headers, cookies, HTML,
files, redirects, streams, SSE, caching headers, or how a type is serialised. Error
responses are `sillo-errors`; paged responses are `sillo-pagination`.

## Inspect first

- How existing handlers return: plain values, or builders. Keep the style consistent.
- Whether routes declare `response_model` — a returned value is filtered through it, a
  built response is not.
- Any `register_encoder` calls or custom response classes in the project.

## How

**Return the value.** That is the default and most handlers need nothing else:
`dict`/`list`/`tuple`/numbers/`None`/Pydantic models/dataclasses/`Decimal` become JSON
with status 200. A `str` (and anything the encoder turns into one — `datetime`, `UUID`,
an `Enum` member) is sent as **text/plain**, never HTML.

**Builders** — all importable from `sillo` (or `from sillo import responses` when the
module also needs stdlib `json`/`html`):

```python
from sillo import HttpContext, created, html, json, redirect, see_other

@app.post("/items")
async def store(ctx: HttpContext):
    item = await Item.create(**(await ctx.json))
    return created(item.to_dict(), location=f"/items/{item.id}")     # 201 + Location

@app.get("/welcome")
async def welcome(ctx: HttpContext):
    return html("<h1>Welcome</h1>")

@app.post("/contact")
async def contact(ctx: HttpContext):
    ...
    return see_other("/thanks")                                       # 303 after a POST
```

| Need | Builder |
|---|---|
| JSON with options | `json(data, status_code=, headers=, indent=)` |
| other bodies | `text()`, `html()`, `xml(body, content_type=)`, `raw(bytes, content_type=)` |
| status shorthands | `created(data, location=)`, `accepted(data)`, `no_content()`, `empty(status_code=204)` |
| redirects | `redirect(url)` 302, `see_other` 303, `temporary_redirect` 307, `permanent_redirect` 301 (`preserve_method=True` → 308) |
| files | `file(path)` inline, `download(path, filename)` as attachment |
| streaming | `stream(async_iter, content_type=)`, `ndjson(async_iter)`, `sse(async_iter, retry=, keepalive=15.0)` |
| stop early | `abort(status, detail=, headers=)`, `not_found(detail=)` — these **raise** |

**Shaping a built response** — methods chain and return the response:

```python
return (
    json({"ok": True})
    .set_cookie("theme", "dark", max_age=86400, httponly=True, secure=True, samesite="lax")
    .set_header("X-Request-Id", rid)
    .cache(max_age=60, private=True)      # or .no_cache()
)
```

Also `.status(code)`, `.set_headers({...})`, `.remove_header(k)`, `.delete_cookie(k)`,
`.set_permanent_cookie(k, v)`, `.add_csp_header(policy)`.

**Server-Sent Events:**

```python
from sillo import HttpContext, sse

@app.get("/orders/{order_id:int}/events")
async def order_events(ctx: HttpContext, order_id: int):
    async def events():
        async for update in order_updates(order_id):
            yield {"status": update.status}          # encoded as a data: line
    return sse(events(), retry=3000)                 # keep-alive ping every 15s
```

Yield `ServerSentEvent(data=..., event="status", id=...)` from `sillo.http.sse` for named
events; `last_event_id(ctx)` reads the reconnect header.

**Custom types in JSON:** `from sillo.encoding import register_encoder` then
`register_encoder(Money, lambda m: str(m.amount))` once at import time. More recipes
(file responses, CSV streaming, custom response classes): [recipes.md](references/recipes.md).

## Compose

- `response_model=` on the route filters returned values — `sillo-validation`.
- Error bodies and exception handlers — `sillo-errors`.
- Paginated lists — `sillo-pagination`. Uploaded files served back — `sillo-storage`.
- Pushing to many clients over one connection each is `sillo-websockets` / `sillo-wire`;
  SSE is the simpler one-way option.

## Verify

`TestClient` assertions on `status_code`, `headers["content-type"]`, `headers["location"]`,
`r.cookies`, and the body. For SSE, `client.get(url)` and read `r.text` lines; for
downloads check `content-disposition`.

## Avoid

- Returning an HTML string and expecting HTML — it is `text/plain`; use `html(...)`.
- `.set_header(name, value)` to *change* an existing header: without `override=True` it
  appends a second header line. Use `set_header(name, value, override=True)`.
- `response.set_cookie(...)` on a response that does not exist yet, or anything on `ctx`:
  the builder comes first, setters chain off it.
- Expecting `response_model` to filter a built `json(...)` — it only filters returned
  values, so a built response can leak fields.
- `return abort(...)`: `abort` and `not_found` raise; code after them does not run.
- `set_cookie` defaults to `secure=False`, `httponly=False`: pass them for auth cookies.
- Serving user uploads with `file(...)`: use `download(...)` so browsers do not render
  uploaded HTML on your origin.
