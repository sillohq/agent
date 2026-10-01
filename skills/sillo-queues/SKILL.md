---
name: sillo-queues
title: Queues, jobs & workers
description: >-
  Durable background jobs in Sillo: Job classes, awaiting dispatch, Redis connections, the
  sillo queue:work worker, retries with QRetryMiddleware, delays, failed jobs, batches and
  idempotency.
intents:
  - send order emails in the background
  - move email sending into a queue
  - process this asynchronously so the request is fast
  - retry failed jobs
  - run a worker
  - don't block the request while generating the report
  - queue this for later
capabilities: [queues]
related: [sillo-mail, sillo-background-tasks, sillo-scheduler, sillo-events, sillo-record]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework", "sillo-framework[cache] (redis) for a durable queue", "Redis 6.2+"]
symbols:
  - sillo.work.queue.Job
  - sillo.work.queue.Dispatchable.dispatch
  - sillo.work.queue.Dispatchable.dispatch_after
  - sillo.work.queue.Dispatchable.perform_now
  - sillo.work.queue.Dispatchable.on_connection
  - sillo.work.queue.Dispatchable.on_queue
  - sillo.work.queue.Dispatchable.dispatch_blocking
  - sillo.work.queue.RedisConnection
  - sillo.work.queue.SyncConnection
  - sillo.work.queue.QRetryMiddleware
  - sillo.work.queue.QTimeoutMiddleware
  - sillo.work.queue.QueueWorker
  - sillo.work.queue.MemoryFailedRepository
  - sillo.work.commands.connection_for
  - sillo.work.commands.run_worker
  - sillo.work.commands.build_worker
probes:
  - job_dispatch_is_awaited_and_worker_rebuilds_args
  - dispatch_blocking_refuses_inside_event_loop
  - worker_ignores_tries_and_never_calls_failed_hook
  - retries_come_from_qretry_middleware
  - queue_attribute_does_not_route_on_queue_does
  - perform_now_runs_inline
  - payload_names_job_by_module_path
  - work_installable_ignores_queue_backend_and_is_in_memory
  - connection_for_picks_redis_by_url
sources:
  - core:sillo/work/queue/job.py
  - core:sillo/work/queue/workers.py
  - core:sillo/work/queue/middleware.py
  - core:sillo/work/queue/connection.py
  - core:sillo/work/commands.py
  - core:sillo/work/console.py
  - core:sillo/work/__init__.py
  - docs:v1.0/guides/work/queue.mdx
  - docs:v1.0/guides/work/jobs.mdx
  - pkg:starter/app/bootstrap.py
status: stable
---

## When

Work that must happen but not inside the request: emails, webhooks, report generation,
image processing, third-party calls — anything that must survive a deploy and be
retried. Fire-and-forget work that may be lost is `sillo-background-tasks`; time-based
work is `sillo-scheduler`.

## Inspect first

- An existing `app/jobs/` package and how jobs are wired (sillo-start leaves
  `_register_work` in `app/bootstrap.py` commented out).
- `QUEUE_URL` / `REDIS_URL` in settings and `.env.example`; whether Redis is available.
- How workers run in deployment (a `sillo queue:work` process, a Procfile, compose file).

## How

**A job** is a class; constructor arguments are what gets queued (JSON), so pass ids,
not objects:

```python
# app/jobs/orders.py
from sillo.work.queue import Job, QRetryMiddleware

class SendOrderConfirmation(Job):
    middleware = [QRetryMiddleware(max_attempts=5, base_delay=2.0, max_delay=60.0)]
    timeout = 30                                  # seconds, enforced

    def __init__(self, order_id: int):
        super().__init__()
        self.order_id = order_id

    async def handle(self):
        order = await Order.get(id=self.order_id).prefetch_related("customer")
        if order.confirmation_sent_at:            # idempotent: jobs can run twice
            return
        await send_confirmation(order)            # raise on failure so it retries
        order.confirmation_sent_at = now()
        await order.save(update_fields=["confirmation_sent_at"])
```

**Wiring** — one connection shared by the app (dispatching) and the worker (consuming):

```python
# app/bootstrap.py
from sillo.work.commands import connection_for
from sillo.work.queue import Job

connection = connection_for(settings.queue_url)   # redis://… → RedisConnection; None → in-process
Job.on_connection(connection)                     # every Job subclass dispatches here
SendOrderConfirmation.on_queue("emails")          # routing is on_queue(), not `queue = ...`
import app.jobs  # noqa: F401  – make the classes importable/registered
```

**Dispatch** from a handler — it is a coroutine:

```python
await SendOrderConfirmation.dispatch(order.id)                 # returns the job id
await SendOrderConfirmation.dispatch_after(3600, order.id)     # delayed, seconds
await SendOrderConfirmation.perform_now(order.id)              # inline, no queue (tests)
SendOrderConfirmation.dispatch_blocking(order.id)              # scripts only (no running loop)
```

**The worker** is a separate process that imports the app (for `Job.on_connection` and
the job modules) and reads `QUEUE_URL`:

```bash
QUEUE_URL=redis://localhost:6379/0 sillo queue:work --queue emails --queue default -c 4
sillo queue:list          # depth per queue
sillo queue:failed        # jobs that raised
sillo queue:forget <id> ; sillo queue:flush
```

Queues are consumed in the order given. Jobs are resolved by `module.Class`, so job
modules must be importable in the worker's environment.

**Failure semantics** — know them before relying on retries:
- A job that raises is logged to the failed-job repository and **not retried** unless its
  `middleware` includes `QRetryMiddleware` (which retries in-process with backoff).
- The `tries`, `backoff` class attributes and the `failed()` hook are **not used** by the
  worker in 1.0.
- Redis delivery is at-least-once (`visibility_timeout`, default 300 s): a job can run
  twice. Make `handle()` idempotent.

More (batches, custom connections, in-process workers, testing):
[advanced.md](references/advanced.md).

## Compose

- Email from a job — `sillo-mail` (raise when `result.success` is false so it retries).
- Enqueue from model signals/events — `sillo-events`, `sillo-record`.
- Nightly enqueueing — `sillo-scheduler`. Redis itself — `sillo-cache` extras.

## Verify

- Unit: `await MyJob.perform_now(...)` (or `await MyJob(...).handle()`) and assert the
  side effect.
- Integration: dispatch through the endpoint and assert `await connection.size("emails")`
  grew; or run a `QueueWorker` over a `SyncConnection` in the test (advanced.md).
- Locally: `sillo queue:work` against Redis and watch the job run; `sillo queue:failed`
  shows exceptions.

## Avoid

- `SendEmail.dispatch(...)` without `await` — nothing is queued.
- `queue = "emails"` on the class and expecting routing: use `on_queue("emails")`.
- `tries = 3` / `backoff = 30` / `async def failed(...)` expecting the worker to use them.
- Shipping the default in-process queue (`setup_work` / `Work()` always create a
  `SyncConnection`, and `queue_backend=` is ignored): jobs are lost on restart and never
  reach a separate worker. Use `connection_for(QUEUE_URL)` with Redis.
- Dispatching inside a database transaction that may roll back — dispatch after commit.
- Passing model instances or the app into a job; pass ids and look things up in `handle`.
