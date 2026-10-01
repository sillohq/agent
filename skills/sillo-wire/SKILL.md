---
name: sillo-wire
title: Realtime rooms with sillo-wire
description: >-
  Rooms, presence and fan-out for Sillo WebSockets with sillo-wire: Hub, Peer, RoomConsumer, bounded
  per-peer queues and overflow policy, DeliveryReport, replayable backlog, and FakeSocket tests.
intents:
  - build a chat room over websockets
  - broadcast to everyone in a room
  - show who is online in a room
  - a slow client is holding up the broadcast
  - replay missed messages after a reconnect
capabilities: [realtime_rooms]
related: [sillo-websockets, sillo-events, sillo-auth, sillo-testing]
requires: [sillo, sillo-websockets]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-wire>=1.0"]
symbols:
  - sillo_wire.Hub
  - sillo_wire.Peer
  - sillo_wire.RoomConsumer
  - sillo_wire.Overflow
  - sillo_wire.DeliveryReport
  - sillo_wire.Envelope
  - sillo_wire.Backlog
  - sillo_wire.MemoryBacklog
  - sillo_wire.NullBacklog
  - sillo_wire.testing.FakeSocket
  - sillo_wire.testing.drain
probes: []
sources:
  - pkg:sillo-wire/README.md
  - pkg:sillo-wire/sillo_wire/hub.py
  - docs:packages/wire/index.md
status: stable
---

## When

More than one WebSocket client needs to hear the same thing: chat, live dashboards,
notifications to a person on several devices, presence. A single socket echoing back to its
own client is plain `sillo-websockets`.

## Inspect first

- Existing `ws_route` handlers and where connections are tracked (a global set of sockets is
  what this replaces).
- Whether clients reconnect and need missed messages (replay) or only current state.

## How

```python
from sillo_wire import Hub, Peer

hub = Hub()                      # an ordinary object: one per world, one per test

@app.ws_route("/ws/room/{name}")
async def room(socket, name: str):
    await socket.accept()
    peer = Peer(socket, identity=socket.query_params.get("user"))
    await hub.join(peer, name)
    try:
        async for message in socket.iter_json():
            await hub.broadcast(name, message)
    finally:
        await hub.disconnect(peer)
```

- `broadcast` only enqueues (each peer has a bounded queue and a writer task) and returns a
  `DeliveryReport` (`delivered`, `dropped`, `failed`, `attempted`).
- Slow consumers: `Peer(socket, overflow=Overflow.DROP_OLDEST | DROP_NEWEST | CLOSE)`. Pick
  deliberately: oldest for prices and cursors, newest to keep order, close to force a reconnect.
- Presence: `@hub.on_join` / `@hub.on_leave`; `hub.identities(room)` is people, `hub.count(room)`
  subscriptions. `await hub.send_to("ada", payload)` reaches every connection of that identity.
- Replay: every envelope has a monotonic `seq`; `await hub.replay(peer, room, since=last_seq)`.
  Retention: `Hub(backlog=MemoryBacklog(capacity_bytes=...))`, `NullBacklog()` for ephemeral
  traffic. `Backlog` is a `Protocol`, so Redis/Postgres stores need no import from here.
- Class form: subclass `RoomConsumer`, set `hub`, implement `identify(ctx)`, `rooms(ctx)`,
  `on_message(data)`, use `self.broadcast(...)`, register `Chat.as_handler()` with
  `app.add_ws_route(path=..., handler=...)`. Cleanup from every room is guaranteed.

## Compose

Auth for the handshake — `sillo-auth` / `sillo-websockets` (authenticate before `join`);
domain events fanned out to rooms — `sillo-events`; the Hub is in-process, so multiple workers
need your own bridge (Redis pub/sub) feeding `hub.broadcast`.

## Verify

```python
from sillo_wire.testing import FakeSocket, drain

hub, socket = Hub(), FakeSocket()
peer = Peer(socket)
await hub.join(peer, "lobby")
await hub.broadcast("lobby", {"hello": True})
await drain(peer)                 # broadcasts enqueue; wait for the write
assert socket.sent == [{"hello": True}]
```

`FakeSocket(delay=...)` simulates a slow reader and `FakeSocket(fail=True)` a gone client.

## Avoid

- Writing to each socket in a loop: the slowest client then paces the room.
- A module-level `Hub` shared by tests: create one per case.
- Skipping `hub.disconnect(peer)` in a `finally`: peers leak into rooms.
- Assuming cross-process delivery: one Hub lives in one process.
- Asserting on `socket.sent` without `await drain(peer)`.
