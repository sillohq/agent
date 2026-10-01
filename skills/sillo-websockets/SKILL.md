---
name: sillo-websockets
title: WebSockets
description: >-
  WebSocket endpoints in Sillo: ws_route, WebSocketContext send/receive/iter, path params, Depend, authenticating sockets, close codes, and testing with websocket_connect.
intents:
  - add a websocket endpoint
  - add live notifications
  - stream updates to the browser over a websocket
  - authenticate websocket connections
  - test my websocket route
capabilities: [websockets]
related: [sillo-wire, sillo-events, sillo-auth, sillo-testing]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework", "websockets or wsproto (for uvicorn)"]
symbols:
  - sillo.WebSocketContext
  - sillo.WebSocketDisconnect
  - sillo.application.SilloApp.ws_route
  - sillo.application.SilloApp.add_ws_route
  - sillo.websockets.WebSocketContext.accept
  - sillo.websockets.WebSocketContext.send_json
  - sillo.websockets.WebSocketContext.receive_json
  - sillo.websockets.WebSocketContext.iter_json
  - sillo.websockets.WebSocketContext.close
  - sillo.websockets.WebSocketContext.is_connected
  - sillo.websockets.status
  - sillo.testclient.TestClient.websocket_connect
probes:
  - websocket_route_path_params_and_dependencies
  - no_app_websocket_decorator
sources:
  - core:sillo/websockets/base.py
  - core:sillo/core/routing/websocket.py
  - core:sillo/application.py
  - docs:v1.0/guides/websockets/index.mdx
status: stable
---

## When

A single bidirectional connection per client: a live feed, a collaborative editor
session, a game. Broadcasting to *rooms* of many connections, presence and fan-out
across processes are `sillo-wire`; one-way server-to-browser streams are often simpler
as SSE (`sillo-responses`).

## Inspect first

- Existing `ws_route` handlers and whether `sillo-wire` is installed.
- That the ASGI server can speak WebSocket: `pip install websockets` (or `wsproto`) —
  without it uvicorn never completes the handshake.
- How the page authenticates (session cookie vs token in the query string).

## How

```python
from sillo import Depend, WebSocketContext, WebSocketDisconnect

@app.ws_route("/ws/orders/{order_id}")
async def order_updates(ws: WebSocketContext, order_id: str, feed=Depend(get_feed)):
    await ws.accept()
    try:
        async for update in feed.for_order(order_id):
            await ws.send_json({"status": update.status})
    except WebSocketDisconnect:
        pass
```

- Register with `@app.ws_route(path)` or `app.add_ws_route(path=..., handler=...)`, or on
  a `Router` (`router.add_ws_route(...)`). There is no `@app.websocket`.
- The handler's first argument is a `WebSocketContext`; path parameters bind by name;
  `Depend(...)` resolves once per connection (`get_context=True` passes the socket
  context).
- API: `accept()`, `send_text/bytes/json`, `receive_text/bytes/json`,
  `async for msg in ws.iter_json()`, `close(code=, reason=)`, `is_connected()` (a
  method), `query_params`, `headers`, `cookies`, `path_params`, `client`.

**Authenticating** — decide before `accept()`:

```python
from sillo.websockets import status

@app.ws_route("/ws/notifications")
async def notifications(ws: WebSocketContext):
    user = await user_from_token(ws.query_params.get("token"))   # or a session cookie
    if user is None:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await ws.accept()
    ...
```

HTTP middleware (sessions, auth) targets HTTP requests; verify identity inside the socket
handler.

**Live notifications to many users** — keep each socket in a room and broadcast from
anywhere: that is exactly `sillo-wire` (`Hub`, `RoomConsumer`). For a hand-rolled version
keep a per-process registry of connections; it will not work across multiple workers.

## Compose

Rooms, presence, fan-out, backlogs — `sillo-wire`. Triggering pushes from model changes
— `sillo-events`. Tests — `sillo-testing`.

## Verify

```python
from sillo.testclient import TestClient

def test_order_updates():
    with TestClient(app) as client:
        with client.websocket_connect("/ws/orders/42") as ws:
            assert ws.receive_json() == {"status": "paid"}
```

Run the server once with `sillo dev` and connect from a browser to confirm the handshake.

## Avoid

- `@app.websocket(...)` / `@app.route(...)`: use `ws_route`.
- Forgetting `await ws.accept()` before sending.
- `if ws.is_connected:` — it is a method; call it.
- Relying on HTTP auth middleware or `useAuth` for sockets; check in the handler.
- `send_json(ws.path_params)` — send plain dicts.
- Deploying without `websockets`/`wsproto` installed.
