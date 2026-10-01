---
name: sillo-testing
title: Testing
description: >-
  Testing Sillo apps with pytest: TestClient and AsyncTestClient, app and database fixtures, dependency overrides, auth, WebSocket tests, jobs, mail and time-dependent code.
intents:
  - write tests for this endpoint
  - add a test for the login flow
  - set up pytest for the Sillo app
  - use a test database
  - mock a dependency in tests
  - test the websocket route
capabilities: [testing]
related: [sillo-dependency-injection, sillo-record, sillo-auth, sillo-queues, sillo-mail, sillo-debugging]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework[test]", "pytest", "pytest-asyncio (for async tests)"]
symbols:
  - sillo.testclient.TestClient
  - sillo.testclient.AsyncTestClient
  - sillo.testclient.TestClient.websocket_connect
  - sillo.application.SilloApp.override
  - sillo.record.factories.Factory
  - sillo.users.SimpleUser
probes:
  - testclient_runs_lifespan_only_as_context_manager
  - testclient_hangs_when_a_startup_hook_raises
  - dependency_override_context_manager
  - websocket_route_path_params_and_dependencies
  - session_login_flow_with_auth_registered_before_session
  - mail_suppress_send_returns_result_and_never_raises
sources:
  - core:sillo/testclient/base.py
  - core:sillo/testclient/async_client.py
  - pkg:starter/tests/conftest.py
  - docs:v1.0/advanced/test-client.md
  - docs:v1.0/guides/start/testing.md
status: stable
---

## When

Writing or fixing tests for a Sillo application, or verifying any change another skill
made. Every framework-level change should end with a test run.

## Inspect first

`tests/conftest.py` (sillo-start ships a good one), how the app is built (a
`create_app()` factory is easiest to test), `[tool.pytest.ini_options]`
(`asyncio_mode = "auto"`?), and how the database is configured for tests.

## How

**Fixtures** — the pattern sillohq/starter uses: a fresh app and database per test, and
the client entered as a context manager so startup hooks run (database connect, mail,
scheduler):

```python
# tests/conftest.py
import sys
import pytest

@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("SILLO_ENV_FILE", "")                        # never read the dev .env
    monkeypatch.setenv("DATABASE_URL", f"sqlite://{tmp_path / 'test.db'}")
    monkeypatch.setenv("MAIL_SUPPRESS_SEND", "true")
    for name in [m for m in sys.modules if m == "app" or m.startswith(("app.", "database.", "routes."))]:
        sys.modules.pop(name)                                        # re-read settings per test

@pytest.fixture
def app():
    from app.bootstrap import create_app
    return create_app()

@pytest.fixture
def client(app):
    from sillo.testclient import TestClient
    with TestClient(app) as test_client:
        yield test_client
```

With `generate_schemas` on (the default) tables are created at startup; to exercise real
migrations instead, see `sillo-migrations` (programmatic.md).

**Requests** — httpx-style: `client.get(path, params=, headers=)`,
`client.post(path, json=... | data=... | files={"f": (name, bytes, type)})`, `.status_code`,
`.json()`, `.headers`, `.cookies`. The client keeps cookies, so logging in through the
real endpoint authenticates later requests. `TestClient(app, raise_server_exceptions=False)`
to assert on 500 responses; `follow_redirects=False` to assert redirects.

**Async tests:** `async with AsyncTestClient(app) as client: r = await client.get(...)`.

**Overrides:**

```python
def test_uses_fake_gateway(app, client):
    with app.override(get_payment_gateway, lambda: FakeGateway()):
        assert client.post("/checkout", json={...}).status_code == 201
```

**Auth in tests:** create users with the model manager or a `Factory`, then log in via the
endpoint (session) or send `Authorization: Bearer <TokenForUser(...).access_token()>`.
Cover anonymous (401), wrong user (403/404) and right user.

**WebSockets:** `with client.websocket_connect("/ws/room/1") as ws: ws.send_json(...); ws.receive_json()`.

Jobs: `await MyJob.perform_now(...)`; mail: `MAIL_SUPPRESS_SEND=true`; background tasks:
keep the handle and `await bt.wait()`. More patterns: [patterns.md](references/patterns.md).

## Compose

Factories and seed data — `sillo-record`. Dependency overrides — `sillo-dependency-injection`.
Queue/mail specifics — `sillo-queues`, `sillo-mail`. Failing tests — `sillo-debugging`.

## Verify

Run `uv run pytest -q` (or the project's runner). Run the specific new test first, then
the suite.

## Avoid

- `client = TestClient(app)` without `with`: startup hooks never run, so the database is
  not connected and `app.state` is empty — "works in production, fails in tests".
- A startup hook that raises inside `with TestClient(app)`: in sillo-framework 1.0.0 the
  test hangs instead of failing. If a test run stalls at the fixture, call
  `await app._startup()` directly (or run the app with `sillo dev`) to see the exception.
- Reading the developer's `.env` in tests: set `SILLO_ENV_FILE=""`.
- Calling an `@app.get`-decorated function directly: the name is `None`. Test through the
  client, or test the underlying service function.
- Asserting only status codes on error paths; assert the body too.
- Sharing one app instance across tests that mutate state.
