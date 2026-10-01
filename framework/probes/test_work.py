"""Queues, jobs, workers, the scheduler and background tasks."""

import asyncio

import pytest

from sillo.work.queue import (
    ConnectionManager,
    Job,
    MemoryFailedRepository,
    PayloadSerializer,
    QRetryMiddleware,
    QueueWorker,
    SyncConnection,
    WorkerOptions,
)

LOG: list = []


class Greet(Job):
    def __init__(self, name: str, *, punctuation: str = "!"):
        super().__init__()
        self.name = name
        self.punctuation = punctuation

    async def handle(self):
        LOG.append(f"hello {self.name}{self.punctuation}")


class Explodes(Job):
    tries = 5  # never read by the worker
    backoff = 1  # never read by the worker

    async def handle(self):
        LOG.append("explodes")
        raise RuntimeError("boom")

    async def failed(self, exception):
        LOG.append("failed-hook")  # never called by the worker


class Flaky(Job):
    middleware = [QRetryMiddleware(max_attempts=3, base_delay=0.0)]

    async def handle(self):
        LOG.append("flaky")
        if LOG.count("flaky") < 3:
            raise RuntimeError("transient")


class RoutedByAttribute(Job):
    queue = "emails"  # documented as routing; dispatch ignores it


async def _drain(connection, queues, seconds=0.3):
    repo = MemoryFailedRepository()
    worker = QueueWorker(
        _manager(connection),
        PayloadSerializer(),
        repo,
        options=WorkerOptions(queues=queues, concurrency=1, sleep=0.05),
    )
    task = asyncio.create_task(worker.run())
    await asyncio.sleep(seconds)
    worker.stop()
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass
    return repo


def _manager(connection):
    manager = ConnectionManager()
    manager.add("default", connection)
    return manager


@pytest.fixture(autouse=True)
def _reset():
    LOG.clear()
    yield
    Job._connection = None


async def test_job_dispatch_is_awaited_and_worker_rebuilds_args():
    connection = SyncConnection()
    Job.on_connection(connection)
    job_id = await Greet.dispatch("ada", punctuation="?")
    assert isinstance(job_id, str)
    await _drain(connection, ["default"])
    assert LOG == ["hello ada?"]


async def test_dispatch_blocking_refuses_inside_event_loop():
    Job.on_connection(SyncConnection())
    with pytest.raises(RuntimeError, match="await Greet.dispatch"):
        Greet.dispatch_blocking("x")


async def test_worker_ignores_tries_and_never_calls_failed_hook():
    connection = SyncConnection()
    Job.on_connection(connection)
    await Explodes.dispatch()
    repo = await _drain(connection, ["default"])
    assert LOG.count("explodes") == 1
    assert "failed-hook" not in LOG
    failures = await repo.all()
    assert len(failures) == 1 and "boom" in failures[0].exception


async def test_retries_come_from_qretry_middleware():
    connection = SyncConnection()
    Job.on_connection(connection)
    await Flaky.dispatch()
    repo = await _drain(connection, ["default"])
    assert LOG.count("flaky") == 3
    assert await repo.all() == []


async def test_queue_attribute_does_not_route_on_queue_does():
    connection = SyncConnection()
    Job.on_connection(connection)
    await RoutedByAttribute.dispatch()
    assert await connection.size("default") == 1
    assert await connection.size("emails") == 0
    RoutedByAttribute.on_queue("emails")
    await RoutedByAttribute.dispatch()
    assert await connection.size("emails") == 1


async def test_perform_now_runs_inline():
    await Greet.perform_now("grace")
    assert LOG == ["hello grace!"]


def test_payload_names_job_by_module_path():
    import json

    payload = json.loads(Greet._encode_payload(("a",), {}))
    assert payload["job"] == f"{Greet.__module__}.Greet"


def test_work_installable_ignores_queue_backend_and_is_in_memory():
    from sillo import SilloApp
    from sillo.work import Work, setup_work

    app = SilloApp()
    state = setup_work(app, queue_backend=object())
    assert type(state["connection"]).__name__ == "SyncConnection"
    assert app.state["queue_connection"] is state["connection"]
    assert "scheduler" in app.state and "events" in app.state
    assert setup_work(app) is state  # idempotent by name
    assert Work.name == "work"


def test_connection_for_picks_redis_by_url():
    from sillo.work.commands import connection_for

    assert type(connection_for(None)).__name__ == "SyncConnection"
    pytest.importorskip("redis")
    assert type(connection_for("redis://localhost:6379/0")).__name__ == "RedisConnection"
    with pytest.raises(ValueError):
        connection_for("amqp://x")


def test_scheduler_decorators_return_scheduled_job():
    from sillo.work.scheduler import ScheduledJob, SchedulerManager

    s = SchedulerManager()

    @s.every(300)
    async def poll():
        return "ran"

    @s.cron("0 2 * * *")
    async def nightly():
        return "ran"

    assert isinstance(poll, ScheduledJob) and isinstance(nightly, ScheduledJob)
    assert not callable(poll) or not asyncio.iscoroutinefunction(poll)
    assert {j.name for j in s.list()} >= {"poll", "nightly"}
    assert not hasattr(s, "jobs")


async def test_background_task_runs_and_waits():
    from sillo.work.background import BackgroundTask

    async def work(x):
        LOG.append(x)
        return x * 2

    bt = BackgroundTask.run(work, 21)
    assert await bt.wait(timeout=2) == 42
    assert LOG == [21]
