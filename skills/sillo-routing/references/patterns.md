# Routing patterns

## A resource module

```python
from sillo import HttpContext, Router, created, no_content, not_found
from sillo.auth import useAuth

router = Router(prefix="/api/orders", tags=["orders"])


@router.get("/", auth=useAuth())
async def index(ctx: HttpContext):
    return [o.to_dict() for o in await Order.filter(owner_id=ctx.user.id)]


@router.get("/{order_id:int}", name="orders.show", auth=useAuth())
async def show(ctx: HttpContext, order_id: int):
    order = await Order.get_or_none(id=order_id, owner_id=ctx.user.id)
    if order is None:
        not_found()
    return order.to_dict()


@router.delete("/{order_id:int}", auth=useAuth())
async def destroy(ctx: HttpContext, order_id: int):
    deleted = await Order.filter(id=order_id, owner_id=ctx.user.id).delete()
    if not deleted:
        not_found()
    return no_content()
```

`routes/__init__.py` imports the module and the bootstrap mounts it:

```python
from routes.orders import router as orders_router

app.mount_router(orders_router)
```

## Versioned APIs

Two ways, pick one per project:

```python
v1 = Router(prefix="/api/v1")
v2 = Router(prefix="/api/v2")                       # by URL

items_v1 = Router(prefix="/items", version="1")     # by header:
items_v2 = Router(prefix="/items", version="2")     # X-API-Version: 2
```

## Host-scoped routers

```python
admin = Router(prefix="/", host="admin.example.com")   # exact host
tenant = Router(prefix="/", host="*.example.com")      # one wildcard label
```

## Custom converters

```python
import re
from sillo.core.converters import Convertor, register_url_convertor


class VersionConvertor(Convertor[str]):
    regex = r"v[0-9]+(\.[0-9]+)*"

    def convert(self, value: str) -> str:
        return value

    def to_string(self, value: str) -> str:
        return value


register_url_convertor("version", VersionConvertor())


@app.get("/api/{version:version}/status")
async def status(ctx: HttpContext, version: str):
    return {"version": version}
```

Register converters before the routes that use them are declared.

## Groups

```python
from sillo.core.routing import Group, Route

app.add_route(
    Group(
        path="/internal",
        middleware=[require_internal_token],
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/metrics", metrics, methods=["GET"]),
        ],
    )
)
```

A `Group` with `app=` mounts any ASGI application (StaticFiles, another framework's app)
under the path.

## Introspection

```python
from sillo.core.routing import format_routes, iter_routes

for info in iter_routes(app.router):      # RouteInfo: methods, path, name, endpoint, kind
    print(info)
print(format_routes(app.router))          # the aligned table `sillo routes` prints
app.print_routes()
```

A test that every non-public route requires auth:

```python
PUBLIC = {"/", "/healthz", "/docs", "/openapi.json", "/api/auth/login"}

def test_everything_else_needs_auth(client):
    for info in iter_routes(app.router):
        if info.kind != "http" or info.path in PUBLIC or "GET" not in info.methods or "{" in info.path:
            continue
        assert client.get(info.path).status_code in (401, 403), info.path
```

## Behind a proxy prefix

`SilloApp(root_path="/api")` when the proxy serves the app under `/api` and strips it:
matching ignores the prefix, and `url_for` and the OpenAPI `servers` add it back.
