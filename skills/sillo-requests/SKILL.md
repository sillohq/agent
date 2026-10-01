---
name: sillo-requests
title: Requests & HttpContext
description: >-
  Reading an incoming request in Sillo through HttpContext: JSON, form data, uploaded files,
  raw body, query and path params, headers, cookies, client IP, per-request state, user and
  session.
intents:
  - read the JSON body in this handler
  - get the uploaded file from the form
  - read a header from the request
  - get the client IP address
  - read query parameters
  - store something on the request for later middleware
  - get the current user in the handler
capabilities: [context, cookies_headers]
related: [sillo-validation, sillo-responses, sillo-routing, sillo-middleware]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.HttpContext
  - sillo.BaseContext
  - sillo.core.http.context.HttpContext.json
  - sillo.core.http.context.HttpContext.form
  - sillo.core.http.context.HttpContext.files
  - sillo.core.http.context.HttpContext.body
  - sillo.core.http.context.HttpContext.text
  - sillo.core.http.context.HttpContext.stream
  - sillo.core.http.context.HttpContext.get_client_ip
  - sillo.core.http.context.HttpContext.validated_data
  - sillo.core.http.context.HttpContext.session
  - sillo.core.http.context.BaseContext.query_params
  - sillo.core.http.context.BaseContext.headers
  - sillo.core.http.context.BaseContext.cookies
  - sillo.core.http.context.BaseContext.state
  - sillo.core.http.context.HttpContext.url_for
  - sillo.objects.UploadedFile
  - sillo.objects.FormData
  - sillo.helpers.network.get_client_ip
probes:
  - ctx_json_is_awaited_without_parentheses
  - uploads_are_uploadedfile_in_a_dict_and_form_markers_bind
  - ctx_user_without_auth_middleware_raises
  - get_client_ip_trusts_forwarded_for_unconditionally
sources:
  - core:sillo/core/http/context.py
  - core:sillo/objects/http.py
  - core:sillo/helpers/network.py
  - docs:v1.0/guides/request-info.md
  - docs:v1.0/guides/request-inputs.md
status: stable
---

## When

A handler, dependency or middleware needs something from the incoming request and no
validation marker already provides it. When the input should be validated and
documented, prefer `sillo-validation` markers (`Query`, `Header`, `Form`, `File`) or a
`request_model` over reading `ctx` by hand.

## Inspect first

- The handler's route: path parameters bind by name, so check the `{name:converter}` in
  the path before reading `ctx.path_params`.
- Whether the route already has a `request_model` (then use `ctx.validated_data` or the
  injected parameter, not `await ctx.json`).
- Which middleware is installed: `ctx.user` needs `AuthenticationMiddleware`,
  `ctx.session` needs `SessionMiddleware`.

## How

Every HTTP handler receives an `HttpContext` as its first argument (`ctx` by
convention). It describes the request only — responses are returned, never set on
`ctx`.

**Bodies** are awaitable properties — `await` them, **no parentheses** — parsed once
and cached for the request:

```python
from sillo import HttpContext

@app.post("/items")
async def create(ctx: HttpContext):
    data = await ctx.json          # dict/list from a JSON body
    raw = await ctx.body           # bytes
    text = await ctx.text          # decoded str
    form = await ctx.form          # FormData (urlencoded or multipart)
    files = await ctx.files        # dict: field name -> UploadedFile
```

**Uploads.** `files["avatar"]` is an `UploadedFile` with `.filename`, `.content_type`,
`await .read()`, `.seek()`, `.save(...)`, `.close()`. Form fields: `form.get("title")`.
For large uploads stream to storage instead of reading into memory (`sillo-storage`,
`stream_upload`); for chunked raw bodies `async for chunk in ctx.stream: …`.

**Everything else on the context:**

| | |
|---|---|
| `ctx.method`, `ctx.url`, `ctx.path`, `ctx.base_url` | the request line |
| `ctx.path_params` | converted path values (prefer handler parameters) |
| `ctx.query_params.get("q")`, `.getlist("tag")` | query string, strings only |
| `ctx.headers.get("x-api-key")`, `ctx.has_header(...)`, `ctx.get_header(name, default)` | case-insensitive |
| `ctx.cookies.get("theme")` | request cookies |
| `ctx.client` | `(host, port)` of the direct peer, or `None` |
| `ctx.user_agent`, `ctx.origin`, `ctx.referrer` | common headers |
| `ctx.is_json`, `ctx.is_form`, `ctx.is_multipart`, `ctx.accepts_json`, `ctx.is_secure` | flags |
| `ctx.state` | per-request attribute bag: `ctx.state.request_id = …` |
| `ctx.app.state` | the process-wide dict (`ctx.app.state["record"]`) |
| `ctx.user` | the authenticated user (needs auth middleware) |
| `ctx.session` | the session mapping (needs session middleware) |
| `ctx.validated_data` | the validated `request_model` instance |
| `ctx.url_for(name, **params)` | build a URL for a named route |

**Client IP.** `ctx.get_client_ip()` returns the first `X-Forwarded-For` entry if the
header is present — from anyone. That is fine for display; for anything
security-relevant (rate limits, allow-lists, audit logs) resolve it against your
proxies:

```python
from sillo.helpers.network import get_client_ip

ip = get_client_ip(ctx.headers, ctx.client.host if ctx.client else "", trusted_proxies=["10.0.0.0/8"])
```

## Compose

- Validated inputs and documented parameters: `sillo-validation`.
- Returning the result: `sillo-responses`.
- `ctx.user` and gates: `sillo-auth`. `ctx.session`: `sillo-sessions`.
- Reading the body in middleware (signatures, logging): `sillo-middleware`.

## Verify

Drive the handler with `TestClient`: `client.post(path, json=...)`,
`client.post(path, data={...}, files={"avatar": ("a.png", b"...", "image/png")})`,
`headers={...}`, `cookies={...}`, and assert on the response.

## Avoid

- `await ctx.json()` — the property is already awaitable; calling it raises `TypeError`,
  which a broad `except` turns into a mysterious "empty body".
- `request.json`, `request.form`: there is no `request` object in 1.x; it is `ctx`.
- `ctx.user` without `AuthenticationMiddleware`: it raises (a 500), it is not `None`.
- `ctx.get_client_ip()` for security decisions behind an untrusted network path.
- Setting the status or cookies on `ctx` — build a response instead (`sillo-responses`).
- Reading a large upload with `await file.read()` in memory; stream it.
