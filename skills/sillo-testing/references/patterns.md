# Testing patterns

## A logged-in client (session auth)

```python
@pytest.fixture
def signed_in(client):
    client.post("/api/auth/register", json={"email": "ada@example.com", "username": "ada",
                                            "password": "Str0ngPass!"})
    assert client.post("/api/auth/login", json={"identifier": "ada@example.com",
                                                "password": "Str0ngPass!"}).status_code == 200
    return client
```

Session cookies must not be `Secure` in tests (the client talks to `http://testserver`):
the app's config should set `session_cookie_secure=False` outside production.

## Bearer tokens

```python
from sillo.auth.jwt_auth import TokenForUser

def bearer(user):
    return {"Authorization": f"Bearer {TokenForUser(user, secret=settings.jwt_secret).access_token()}"}
```

Create the user inside the app's database context — through an endpoint, a fixture
that runs inside the lifespan, or `DatabaseManager` directly.

## Database access inside tests

ORM calls need a connected database. Inside `with TestClient(app)` the app's manager is
connected; run async ORM code with an async test:

```python
async def test_order_total(tmp_path):
    from sillo.record import DatabaseConfig, DatabaseManager
    db = DatabaseManager(DatabaseConfig(url=f"sqlite://{tmp_path}/t.db"))
    db.register_models("database.models")
    await db.init()
    try:
        order = await OrderFactory.create()
        assert order.total_cents == 0
    finally:
        await db.shutdown()
```

## Structural tests

```python
from sillo.core.routing import iter_routes

PUBLIC = {"/api/health", "/api/auth/login", "/api/auth/register", "/docs", "/redoc", "/openapi.json"}

def test_every_other_route_requires_auth(client, app):
    for info in iter_routes(app.router):
        if info.kind != "http" or info.path in PUBLIC or "{" in info.path:
            continue
        for method in info.methods:
            if method in ("HEAD", "OPTIONS"):
                continue
            response = client.request(method, info.path)
            assert response.status_code in (401, 403, 405, 422), (method, info.path)
```

This catches DELETE routes registered with `@app.delete(..., auth=...)`, which Sillo 1.0.0
leaves unprotected.

## Queues

```python
async def test_job_logic():
    await SendOrderConfirmation.perform_now(order_id)     # the logic, no queue

def test_endpoint_queues_job(client, monkeypatch):
    from sillo.work.queue import SyncConnection, Job
    connection = SyncConnection()
    Job.on_connection(connection)
    client.post("/orders", json={...})
    import asyncio
    assert asyncio.run(connection.size("emails")) == 1
```

## Time

Freeze or inject time at your own seams (a `now()` dependency overridden with
`app.override`) rather than patching `datetime` globally.

## Snapshotting the OpenAPI document

```python
def test_openapi_is_stable(client):
    spec = client.get("/openapi.json").json()
    assert set(spec["paths"]) >= {"/api/orders", "/api/orders/{order_id}"}
```
