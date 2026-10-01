---
name: sillo-routing
title: Routing
description: >-
  Sillo routes: method decorators, Router prefixes and mounting, typed path converters,
  route names and url_for, redirects, trailing slashes, host/version routers, static
  files and mounting other ASGI apps.
intents:
  - add a GET endpoint for products
  - build a products CRUD API
  - group these routes under /api/v1
  - add a route with an integer id in the path
  - serve static files from ./static
  - redirect the old URL to the new one
  - list all the routes in the app
  - generate the URL for a named route
capabilities: [routing, static_files]
related: [sillo-requests, sillo-responses, sillo-validation, sillo-middleware, sillo-auth]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.Router
  - sillo.Group
  - sillo.Route
  - sillo.application.SilloApp.get
  - sillo.application.SilloApp.post
  - sillo.application.SilloApp.add_route
  - sillo.application.SilloApp.mount_router
  - sillo.application.SilloApp.redirect
  - sillo.application.SilloApp.url_for
  - sillo.application.SilloApp.print_routes
  - sillo.core.converters.register_url_convertor
  - sillo.core.converters.Convertor
  - sillo.core.routing.iter_routes
  - sillo.static.StaticFiles
probes:
  - no_app_route_decorator
  - path_converter_binds_typed_parameter
  - literal_route_beats_parameter_regardless_of_order
  - router_prefix_and_mount
  - url_for_on_context
  - mount_order_does_not_matter_in_1x
  - prefixless_router_does_not_swallow_later_routes
  - static_files_mount_through_group_and_head_is_405
  - declarative_redirect_and_trailing_slash_policy
  - handler_keyword_registration_form
  - app_decorators_return_none_router_decorators_return_the_function
sources:
  - core:sillo/application.py
  - core:sillo/core/routing/router.py
  - core:sillo/core/routing/grouping.py
  - core:sillo/core/converters.py
  - core:sillo/static.py
  - docs:v1.0/guides/routing.mdx
  - docs:v1.0/guides/routers-and-subapps.md
  - docs:v1.0/guides/static-files.mdx
status: stable
---

## When

Adding, organising or debugging endpoints: new routes, a resource's CRUD routes, path
parameters, prefixes and versioned routers, redirects, static files, mounting another
ASGI app, or "why does this URL 404/405". Reading request data is `sillo-requests`;
validating it is `sillo-validation`.

## Inspect first

- Where routes live: a `routes/` package of `Router` modules mounted in the bootstrap is
  the sillo-start layout; small apps decorate `app` directly. Follow what exists.
- `sillo routes` (or `app.print_routes()`) for what is actually registered, with mount
  prefixes folded in.
- The bootstrap's `mount_router` calls and any `Group` mounts.

## How

**Decorators** exist for each method: `@app.get`, `.post`, `.put`, `.patch`, `.delete`,
`.head`, `.options` — on the app and on a `Router`. There is **no** `@app.route(...)`.
A handler takes the context first, then path parameters by name:

```python
from sillo import HttpContext, Router, created, not_found

router = Router(prefix="/api/products", tags=["products"])

@router.get("/", name="products.index")
async def index(ctx: HttpContext):
    return [p.to_dict() for p in await Product.all()]

@router.get("/{product_id:int}", name="products.show")
async def show(ctx: HttpContext, product_id: int):
    product = await Product.get_or_none(id=product_id)
    if product is None:
        not_found(detail=f"Product {product_id} not found")
    return product.to_dict()

@router.post("/")
async def store(ctx: HttpContext):
    product = await Product.create(**(await ctx.json))
    return created(product.to_dict(), location=ctx.url_for("products.show", product_id=product.id))
```

and in the bootstrap: `app.mount_router(router)`. Routers nest (`parent.mount_router(child)`)
and take `middleware=[...]`, `dependencies=[...]`, `tags`, `host="admin.example.com"`,
`version="2"` (matched on `X-API-Version` or `Accept: …; version=2`) and
`trailing_slash=`. Route decorators take `name`, `summary`, `description`, `tags`,
`responses`, `request_model`, `response_model`, `middleware`, `auth` (a `useAuth` gate),
`priority`, `exclude_from_schema`.

**Converters** in `{name:converter}`: `str` (default), `int`, `float`, `uuid`, `path`
(slashes included), `slug`, `bool`, `date`, `datetime`, `ulid`, `alpha`, `alnum`. The
value is bound already converted; a non-matching value is a 404/422. Custom:
`register_url_convertor("key", MyConvertor())` with a `Convertor` subclass (`regex`,
`convert`, `to_string`), registered before routes use it.

**Matching order** is by specificity across the whole app, including mounted routers:
`/users/me` beats `/users/{id}` whatever order they were declared or mounted in, and a
catch-all `{rest:path}` never shadows a more specific route. `priority=` (higher first,
negative for fallbacks) overrides it.

**Other registrations.**

```python
app.get("/", handler=welcome, name="welcome")          # without a decorator
app.add_route(Route("/ping", ping, methods=["GET"]))   # a Route object
app.redirect("/docs", "/docs/latest")                  # 307 by default; status_code=301/308
app.redirect("/u/{user_id}", "/users/{user_id}")       # placeholders carried across
```

`SilloApp(trailing_slash="redirect")` sends `/items/` to `/items` with a 308
(`"ignore"` serves both; `"strict"`, the default, 404s the other form).

**URLs.** `ctx.url_for("name", **params)` inside a handler (it respects `root_path`);
`app.url_for(...)` elsewhere. Redirect to a named route with
`redirect(ctx.url_for("name", id=1))`.

**Static files and other ASGI apps** mount through a `Group`:

```python
from sillo.core.routing import Group
from sillo.static import StaticFiles

app.add_route(Group(path="/static", app=StaticFiles(directory="static")))
```

`Group(path, app=...)` mounts any ASGI application under a prefix; `Group(path,
routes=[...], middleware=[...])` groups `Route` objects. In production let the proxy
serve static files. More on converters, groups and route introspection:
[patterns.md](references/patterns.md).

## Compose

- Protect routes with `auth=useAuth(...)` — `sillo-auth`, `sillo-authorization`.
- Validate inputs with markers / `request_model` — `sillo-validation`.
- Route- and router-scoped middleware — `sillo-middleware`.
- WebSocket routes use `app.ws_route(...)` — `sillo-websockets`.
- Paged list endpoints — `sillo-pagination`. Documented endpoints — `sillo-openapi`.

## Verify

- `sillo routes` (optionally `--method post`) shows the new route under the full prefix.
- A `TestClient` request per route: expected status, and 404/422 for a bad converter value.
- `app.url_for("name", ...)` resolves for every named route you added.

## Avoid

- `@app.route(...)` or `@app.websocket(...)`: neither exists. Use a method decorator, or
  `app.ws_route(...)` for sockets.
- Hand-parsing ids: `int(ctx.path_params["id"])` when `{id:int}` binds an int for you.
- Mount-order rituals copied from Sillo 0.x ("mount the most specific router first",
  "never mount a prefix-less router"): 1.x orders by specificity, so they are
  unnecessary — but harmless where a project already does it.
- Expecting `HEAD` on a static file mounted through `Group`: it answers 405 in 1.0.
- Stacking decorators on the app (`@app.get` over `@app.post`): `@app.<method>(...)`
  returns `None`, so the second decorator fails with "Route handler must be callable".
  For several methods use `app.add_route(Route(path, handler, methods=["GET", "POST"]))`,
  or decorate a `Router` (its decorators return the function).
- Calling an app-decorated handler directly in a unit test — the name is `None` after
  `@app.get`. Test through `TestClient`, or define handlers on a `Router`.
- Two routes with the same path and method: registration raises a conflict.
