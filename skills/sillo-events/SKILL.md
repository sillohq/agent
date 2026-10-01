---
name: sillo-events
title: Events & listeners
description: >-
  Decoupling side effects in Sillo: the app.events emitter (sillo.events, memory/Redis
  transports), typed Event dataclasses with EventDispatcher, model lifecycle signals, and
  which to use.
intents:
  - fire an event when an order is placed
  - add a listener for user registration
  - notify other parts of the app when something happens
  - run code after a model is saved
  - publish events across processes with Redis
capabilities: [events, model_events]
related: [sillo-queues, sillo-record, sillo-wire, sillo-mail]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework", "sillo-framework[events] for the Redis transport"]
symbols:
  - sillo.events.EventEmitter
  - sillo.events.EventEmitter.on
  - sillo.events.EventEmitter.emit_async
  - sillo.events.EventEmitter.emit
  - sillo.events.EventPriority
  - sillo.work.queue.Event
  - sillo.work.queue.EventDispatcher
  - sillo.work.queue.EventDispatcher.register
  - sillo.work.queue.EventDispatcher.dispatch
  - sillo.work.queue.listen
probes:
  - app_events_emitter_on_and_emit_async
  - work_event_dispatcher_and_listen_decorator_does_not_register
  - setup_work_state_events_is_the_work_dispatcher_not_app_events
  - tortoise_signals_fire_automatically
  - has_events_listeners_only_fire_when_fired_by_hand
sources:
  - core:sillo/events/emitter.py
  - core:sillo/application.py
  - core:sillo/work/queue/events.py
  - core:sillo/record/events.py
  - docs:v1.0/guides/events.mdx
  - docs:v1.0/guides/work/events.mdx
status: stable
---

## When

"When X happens, also do Y" without X knowing about Y: after signup, after payment, on
order status changes. Pushing those events to browsers is `sillo-wire`; durable work in
response to an event is `sillo-queues`.

## Inspect first

Which event mechanism the project already uses (they are different objects), where
listeners are registered (they must be imported to be registered), and whether events must
cross processes.

## How

Sillo has three mechanisms. Pick one per concern:

| | Keyed by | Use for |
|---|---|---|
| `app.events` (`sillo.events.EventEmitter`) | string names | app-wide domain events; memory, Redis or record transports |
| `sillo.work.queue.EventDispatcher` | `Event` dataclasses | typed in-process events with priorities |
| Tortoise signals on models | model saves/deletes | reacting to persistence automatically |

**String events on the app:**

```python
@app.events.on("order.placed")
async def queue_confirmation(order: dict):
    await SendOrderConfirmation.dispatch(order["id"])

@app.post("/orders")
async def place_order(ctx: HttpContext):
    order = await Order.create(...)
    await app.events.emit_async("order.placed", {"id": order.id})
    return created(order.to_dict())
```

`once(...)`, `priority=EventPriority.HIGH`, `remove_listener(...)`, `namespace("ui")`.
Across processes: `EventEmitter("redis", url=settings.redis_url)`, assign to `app.events`,
and `await app.events.start()` / `.stop()` in startup/shutdown hooks.

**Typed events:**

```python
from dataclasses import dataclass
from sillo.work.queue import Event, EventDispatcher

@dataclass
class OrderShipped(Event):
    order_id: int

dispatcher = EventDispatcher()
dispatcher.register(OrderShipped, notify_customer, priority=10)
await dispatcher.dispatch(OrderShipped(order_id=order.id))   # awaits every listener
```

`@listen(OrderShipped)` only marks a function — you still `register` it.
`setup_work(app)` puts one of these at `app.state["events"]` (a different object from
`app.events`).

**Model lifecycle** — automatic, via Tortoise signals:

```python
from tortoise.signals import post_save

@post_save(Order)
async def order_saved(sender, instance, created, using_db, update_fields):
    if not created and "status" in (update_fields or []):
        await app.events.emit_async("order.status_changed", {"id": instance.id, "status": instance.status})
```

(`HasEvents` / `ModelObserver` in `sillo.record.events` only fire when you call
`fire_event` — see `sillo-record`.)

## Compose

Listeners that must not be lost enqueue a job — `sillo-queues`. Live updates to
browsers — `sillo-wire`. Emails — `sillo-mail`.

## Verify

Register a listener that records calls, emit, assert. In app tests, emit through the
endpoint and assert the listener's effect (or the queued job).

## Avoid

- Confusing `app.events` with `app.state["events"]` — different classes and APIs.
- Expecting `@listen(...)` or `HasEvents.on(...)` to fire on their own.
- Slow work inside a listener that runs in the request: `emit_async`/`dispatch` await it.
- A listener module never imported: its decorators never ran.
- In-memory events across workers: each process has its own listeners and nothing crosses.
