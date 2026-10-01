---
name: sillo-background-tasks
title: Background tasks (in-process)
description: >-
  Fire-and-forget work in the Sillo web process: BackgroundTask.run, waiting, draining on
  shutdown, Supervisor for long-running loops, and the @task decorator, and when to use a
  durable queue instead.
intents:
  - do this after the response without waiting
  - warm the cache in the background
  - run a long-lived consumer loop alongside the app
  - fire and forget this analytics call
  - wait for background work before shutdown
capabilities: [background_tasks]
related: [sillo-queues, sillo-scheduler, sillo-application]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.work.background.BackgroundTask
  - sillo.work.background.BackgroundTask.run
  - sillo.work.background.BackgroundTask.run_sync
  - sillo.work.background.BackgroundTask.wait
  - sillo.work.background.BackgroundTask.drain
  - sillo.work.background.Supervisor
  - sillo.work.background.RestartPolicy
  - sillo.work.task
probes:
  - background_task_runs_and_waits
  - background_task_drain
sources:
  - core:sillo/work/background/tasks.py
  - core:sillo/work/background/supervisor.py
  - core:sillo/work/task.py
  - docs:v1.0/guides/work/background.mdx
status: stable
---

## When

Work that should not delay the response and **may be lost** on restart without harm:
cache warming, analytics, best-effort notifications, non-critical cleanup; or a
long-running loop owned by the process (a consumer). If losing it would affect a
customer, use `sillo-queues`.

## Inspect first

Existing `BackgroundTask.run(...)` calls and whether shutdown drains them; whether the
app runs several workers (each has its own tasks).

## How

```python
from sillo import HttpContext, json
from sillo.work.background import BackgroundTask

@app.post("/signup")
async def signup(ctx: HttpContext):
    user = await create_user(ctx.validated_data)
    BackgroundTask.run(warm_recommendations, user.id)          # not awaited
    return json({"id": user.id}, status_code=201)
```

`BackgroundTask.run(fn, *args, name=, timeout=, on_success=, on_failure=, on_done=, **kwargs)`
returns a handle: `await bt.wait(timeout=5)` returns the result (raises on failure),
`bt.done`, `bt.cancel()`. Sync functions: `BackgroundTask.run_sync(fn, *args)`; blocking
CPU/IO: `BackgroundTask.run(asyncio.to_thread, fn, arg)`. Keyword arguments named like
the options (`timeout`, `name`, …) are consumed by `run` — use `functools.partial`.

Drain before the process exits:

```python
@app.on_shutdown
async def drain_background():
    await BackgroundTask.drain(timeout=10, cancel_remaining=True)
```

**Supervisor** keeps a long-running coroutine alive:

```python
import asyncio
from sillo.work.background import RestartPolicy, Supervisor

supervisor = Supervisor(consume_events, RestartPolicy.EXPONENTIAL_BACKOFF, max_restarts=5)

@app.on_startup
async def start_consumer():
    app.state["myapp.consumer"] = asyncio.create_task(supervisor.start())   # start() blocks

@app.on_shutdown
async def stop_consumer():
    supervisor.stop()
    await supervisor.wait(timeout=5)
```

`@task(name=, priority=, max_attempts=, timeout=)` from `sillo.work` only attaches
metadata; calling the function still runs it inline.

## Compose

Durable work → `sillo-queues`. Periodic work → `sillo-scheduler`. Startup/shutdown
hooks → `sillo-application`.

## Verify

In tests, keep the handle and `await bt.wait(timeout=...)` before asserting; a
`TestClient` response returns before background work finishes.

## Avoid

- Anything that must happen (payments, confirmation emails): deploys lose it.
- `await supervisor.start()` in a startup hook: it never returns, so startup hangs.
- CPU-heavy work on the event loop; it stalls every request in that process.
- Assuming a background task ran by the time a test asserts.
