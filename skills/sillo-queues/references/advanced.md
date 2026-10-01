# Queues: advanced topics

## Connections

```python
from sillo.work.queue import RedisConnection, SyncConnection

RedisConnection(url="redis://localhost:6379/0", prefix="myapp:queue:", visibility_timeout=300)
SyncConnection()        # in-process: tests and single-process development only
```

`connection_for(url)` picks one from a URL. Connection API: `push(queue, payload, delay=)`,
`pop(queue, timeout=)`, `ack`, `fail`, `size(queue)`, `clear(queue)`;
`RedisConnection.in_flight(queue)` counts jobs taken but not acknowledged (a number that
only grows means workers crash or time out before acking).

## Running a worker from code

```python
import asyncio
from sillo.work.commands import run_worker

import app.jobs  # noqa: F401  – register job classes first

asyncio.run(run_worker(url="redis://localhost:6379/0", queues=["emails", "default"], concurrency=4))
```

`build_worker(...)` returns the `QueueWorker` without running it. A worker installs its
own SIGINT/SIGTERM handler; do not run one inside the web server process in production
(Ctrl-C then stops the worker, not the server).

## In-process worker for development

```python
import asyncio
from sillo.work.commands import build_worker

worker = build_worker(connection=connection, queues=["default"], concurrency=2)
state = {}

@app.on_startup
async def start_worker():
    state["task"] = asyncio.create_task(worker.run())

@app.on_shutdown
async def stop_worker():
    worker.stop()
    state["task"].cancel()
```

It must share the exact connection the app dispatches into. Jobs then run on the web
event loop; a blocking job blocks requests.

## Testing with a real worker

```python
import asyncio
from sillo.work.queue import (ConnectionManager, MemoryFailedRepository, PayloadSerializer,
                              QueueWorker, SyncConnection, WorkerOptions)

async def run_queue_once(queues=("default",), seconds=0.3):
    connection = SyncConnection()
    Job.on_connection(connection)
    manager = ConnectionManager()
    manager.add("default", connection)
    failed = MemoryFailedRepository()
    worker = QueueWorker(manager, PayloadSerializer(), failed,
                         options=WorkerOptions(queues=list(queues), concurrency=1, sleep=0.05))
    task = asyncio.create_task(worker.run())
    await asyncio.sleep(seconds)
    worker.stop()
    task.cancel()
    return failed
```

Dispatch before draining; assert side effects and `await failed.all() == []`.

## Retries and timeouts

```python
from sillo.work.queue import QRateLimitMiddleware, QRetryMiddleware, QTimeoutMiddleware

class CallPartnerAPI(Job):
    middleware = [
        QRetryMiddleware(max_attempts=5, base_delay=1.0, max_delay=60.0),
        QTimeoutMiddleware(seconds=20),
        QRateLimitMiddleware(max_jobs=10, per_seconds=60),
    ]
```

Middleware is a callable `mw(handler) -> async wrapper`, outermost first. Retries happen
inside the worker (it sleeps between attempts), so long backoffs occupy a worker slot.

## Failed jobs

The default repository is in memory (per worker process). Implement
`sillo.work.queue.FailedJobRepository` (`log`, `all`, `find`, `forget`, `flush`) backed by
your database for durable failure records, and pass it as `failed_repository=` to
`build_worker`/`run_worker`. Re-queue a failure with
`await connection.push(failed.queue, failed.payload)`.

## Batches and chains

`Batch(name, on_complete=, allow_failures=, timeout=)` tracks a set of job ids you add
with `batch.add(job_id)`; `await batch.wait()`. `JobChain().then(fn).then(fn)` runs
callables in order in-process. For durable multi-step pipelines, have each job dispatch
the next one at the end of `handle()`.

## Custom brokers

Subclass `sillo.work.queue.QueueConnection` and implement `push`, `pop`, `ack`, `fail`,
`size`, `clear`; pass an instance to `Job.on_connection(...)` and to the worker via
`build_worker(connection=...)`.
