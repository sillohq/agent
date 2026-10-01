---
name: sillo-middleware
title: Middleware
description: >-
  Writing and ordering Sillo middleware: (ctx, call_next) functions, BaseMiddleware, raw ASGI, route and router scope, and built-ins (request IDs, gzip, ETags).
intents:
  - add middleware that times every request
  - why isn't my middleware running
  - add a request id header to every response
  - gzip the responses
  - add ETags so clients can cache
  - apply this middleware only to the admin routes
  - redirect trailing slashes
capabilities: [middleware, content_negotiation, http_caching, url_normalization]
related: [sillo-auth, sillo-sessions, sillo-security, sillo-errors, sillo-logging, sillo-record]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.application.SilloApp.use
  - sillo.middleware.BaseMiddleware
  - sillo.middleware.gzip.GZipMiddleware
  - sillo.http.lifecycle.RequestId
  - sillo.http.etag.ETag
  - sillo.http.accepts.Accepts
  - sillo.normalize.Normalize
  - sillo.normalize.SlashAction
probes:
  - last_use_is_outermost_middleware
  - middleware_short_circuit_and_call_next_takes_no_args
  - session_before_auth_registration_breaks_login
  - session_login_flow_with_auth_registered_before_session
  - first_party_middleware_wiring
  - router_and_route_middleware_order
sources:
  - core:sillo/application.py
  - core:sillo/middleware/base.py
  - core:sillo/middleware/gzip.py
  - core:sillo/http/etag.py
  - core:sillo/http/lifecycle/middleware.py
  - core:sillo/normalize/middleware.py
  - docs:v1.0/guides/middleware.md
  - docs:v1.0/guides/request-lifecycle.md
status: stable
---

## When

Behaviour that wraps every request (or every request under a router/route): timing,
logging, headers, gating, compression, caching headers. Also "my middleware does not
run" or "runs in the wrong order". Values a handler consumes are dependencies
(`sillo-dependency-injection`), not middleware.

## Inspect first

- Every `app.use(...)` call **and its position** in the bootstrap, plus anything that
  registers middleware for you: `setup_record` / `app.install(Record(...))` (a
  per-request database context), `SilloApp(auth=[...])` (authentication),
  `Admin.mount()` in warder.
- Router-level `Router(middleware=[...])` / `router.use(...)` and route-level
  `middleware=[...]`.

## How

**Order: the last `app.use()` is the outermost** — it runs first on the way in and last
on the way out. Register from the inside (closest to the handler) outwards:

```python
app.use(AuthenticationMiddleware(user_model=User, backend=SessionAuthBackend()))  # needs the session
app.use(SessionMiddleware(config=SessionConfig(...), secret_key=settings.secret_key))
app.use(CORSMiddleware(config=CorsConfig(allow_origins=[...])))                   # outermost
setup_record(app, db_config, model_modules=[...])   # its DB context wraps everything above
```

At request time that runs: database context → CORS → session → auth → handler.

**A dispatch middleware** takes the context and a continuation with **no arguments**:

```python
import time
from sillo import HttpContext, json

async def timing(ctx: HttpContext, call_next):
    start = time.perf_counter()
    response = await call_next()
    response.set_header("X-Process-Time", f"{(time.perf_counter() - start) * 1000:.1f}ms", override=True)
    return response

async def require_api_key(ctx: HttpContext, call_next):
    if ctx.headers.get("x-api-key") != settings.api_key:
        return json({"error": "unauthorized"}, status_code=401)    # short-circuit
    return await call_next()

app.use(timing)
```

The class form is `BaseMiddleware` with one `async def dispatch(self, ctx, call_next)`.

**Raw ASGI middleware** (third-party, or no context needed) is a factory called as
`factory(next_app, **kwargs)`; `app.use` infers it from the signature or you say
`raw=True`: `app.use(GZipMiddleware, minimum_size=500)`,
`app.use(SomeASGIMiddleware, raw=True, option=1)`. It sees `scope/receive/send`, not `ctx`.

**Scope.** Route: `@app.get(path, middleware=[mw])` — runs inside app middleware.
Router: `Router(prefix, middleware=[a, b])` (a is outer) and `router.use(c)` (runs
outside the list).

**Built-ins:**

```python
from sillo.http.accepts import Accepts
from sillo.http.etag import ETag
from sillo.http.lifecycle import RequestId
from sillo.middleware.gzip import GZipMiddleware
from sillo.normalize import Normalize, SlashAction

app.use(RequestId())                               # X-Request-ID in and out; ctx.state.request_id
app.use(ETag())                                    # ETag + 304 for If-None-Match
app.use(Accepts())                                 # parses Accept/-Language, sets Vary
app.use(Normalize(slash_action=SlashAction.REDIRECT_REMOVE))   # 301 /a/ -> /a
app.use(GZipMiddleware, minimum_size=500)          # raw ASGI
```

Security middleware (CORS, CSRF, `Shield` headers, rate limits) is in `sillo-security`
and `sillo-rate-limiting`; sessions and authentication in `sillo-sessions` and
`sillo-auth`. A full ordering reference: [ordering.md](references/ordering.md).

## Compose

- Auth + sessions ordering — `sillo-auth`, `sillo-sessions`.
- CORS outermost so rejections still carry CORS headers — `sillo-security`.
- Error formatting from middleware — `sillo-errors`. Request IDs in logs — `sillo-logging`.
- `setup_record`'s per-request context — `sillo-record`.

## Verify

A `TestClient` test per middleware: the header it adds, the short-circuit status it
returns, and — for ordering bugs — that an outer layer rejects before an inner one runs
(count handler calls). Temporarily append to a list in each middleware to see the real
order.

## Avoid

- Registering in "reading order": `app.use(SessionMiddleware)` then
  `app.use(AuthenticationMiddleware)` puts auth *outside* the session, so every request
  is anonymous ("No Session Middleware Installed"). Auth first, session after.
- `await call_next(ctx)` — the continuation takes no arguments.
- Forgetting to `return` the response from `call_next()`: the request hangs.
- `app.add_middleware(...)` or `app.wrap_asgi(...)`: neither exists in 1.x; everything is
  `app.use(...)`.
- Database queries in middleware that runs for every request (static files included).
- Reading the body in middleware without caching it: `await ctx.body` is cached per
  request, but a raw ASGI middleware that consumes `receive` starves the handler.
