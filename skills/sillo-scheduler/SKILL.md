---
name: sillo-scheduler
title: Scheduler & cron
description: >-
  Periodic work in Sillo: SchedulerManager every() and cron(), triggers, max_instances,
  installing the scheduler, running it as its own process with sillo schedule:run, and
  avoiding duplicate runs across workers.
intents:
  - run this every night
  - send a weekly digest every Monday at 9
  - clean up expired sessions every hour
  - run a cron job in the app
  - pause a scheduled task
capabilities: [scheduler]
related: [sillo-queues, sillo-background-tasks, sillo-application, sillo-cli]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.work.scheduler.SchedulerManager
  - sillo.work.scheduler.SchedulerManager.every
  - sillo.work.scheduler.SchedulerManager.cron
  - sillo.work.scheduler.SchedulerManager.schedule
  - sillo.work.scheduler.SchedulerManager.list
  - sillo.work.scheduler.Scheduler
  - sillo.work.scheduler.setup_scheduler
  - sillo.work.scheduler.CronTrigger
  - sillo.work.scheduler.IntervalTrigger
  - sillo.work.scheduler.ScheduledJob
probes:
  - scheduler_decorators_return_scheduled_job
  - scheduler_runs_interval_job
sources:
  - core:sillo/work/scheduler/manager.py
  - core:sillo/work/scheduler/triggers.py
  - core:sillo/work/console.py
  - core:sillo/__main__.py
  - docs:v1.0/guides/work/scheduler.mdx
  - docs:v1.0/cli/scheduler.md
status: stable
---

## When

Time-based work: nightly reports, hourly syncs, periodic cleanup, digests. For work that
must not be lost, the scheduled function should enqueue a job (`sillo-queues`) rather than
do the work inline.

## Inspect first

- Where tasks are registered (sillo-start: `app/tasks/__init__.py` with
  `register_tasks(app)`), and whether `setup_work` / `Scheduler` is installed.
- How many processes run the app: each process that starts the scheduler runs every job.

## How

```python
# app/tasks/__init__.py
from app.jobs.reports import SendWeeklyDigest

def register_tasks(app):
    scheduler = app.state["scheduler"]

    @scheduler.cron("0 9 * * 1")                  # Mondays 09:00
    async def weekly_digest():
        for account_id in await Account.filter(digest=True).values_list("id", flat=True):
            await SendWeeklyDigest.dispatch(account_id)

    @scheduler.every(3600)                        # seconds
    async def purge_expired_tokens():
        await PasswordReset.filter(expires_at__lt=now()).delete()
```

`cron(expression)` uses standard 5-field cron; `every(seconds)`; or
`scheduler.schedule(fn, CronTrigger("0 2 * * *", timezone="Europe/London"), name=, max_instances=1, coalesce=True)`.
The decorators return a `ScheduledJob`, not the function. Manage at runtime with
`scheduler.list()`, `pause(id)`, `resume(id)`, `remove(id)`, `stats`.

**Where it runs.**

- Single process (development, small apps): `app.install(Scheduler())` (or
  `setup_scheduler(app)`, or `setup_work(app)`) starts the scheduler with the app.
- Several web workers: every process that installs it runs each job. Give the web app a
  scheduler without start hooks and run one dedicated process:

```python
from sillo.work.scheduler import SchedulerManager

app.state["scheduler"] = SchedulerManager()   # holds tasks; not started by the web app
register_tasks(app)
```

```bash
sillo schedule:run          # one process; also: schedule:list, schedule:pause <id>, schedule:resume <id>
```

Schedules live in memory and are rebuilt from code at startup; runs missed while down are
skipped, not caught up.

## Compose

Enqueue durable work from scheduled functions — `sillo-queues`. The CLI —
`sillo-cli`. Startup/shutdown — `sillo-application`.

## Verify

`sillo schedule:list` shows each task and its next run. Unit-test the task function by
awaiting it directly — keep a reference to the plain function (`scheduler.schedule(fn, ...)`)
when tests need to call it.

## Avoid

- `await weekly_digest()` after decorating it: it is a `ScheduledJob`, not callable.
- Starting the scheduler in every web worker (`setup_work` / `Scheduler` with
  `--workers N`): the job runs N times.
- Doing long or must-happen work inline in the scheduled function.
- `scheduler.jobs` — the accessor is `scheduler.list()`.
- Relying on `max_instances` for cross-process exclusivity; it is per process.
