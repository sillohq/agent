---
name: sillo-debugging
title: Debugging Sillo applications
description: >-
  Diagnosing Sillo problems: reading the error report, a symptom-to-cause table (middleware not running, 401 after login, 500 instead of 422, migrations, jobs) and a method for the rest.
intents:
  - why am I getting this exception
  - debug why this middleware isn't running
  - debug a failed migration
  - login works but the next request is unauthorized
  - my background jobs never run
  - the tests hang
  - this route returns 404 but I defined it
capabilities: [debugging]
related: [sillo-middleware, sillo-errors, sillo-logging, sillo-testing, sillo-migrations, sillo-queues]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.application.SilloApp.print_routes
  - sillo.core.routing.iter_routes
probes:
  - last_use_is_outermost_middleware
  - session_before_auth_registration_breaks_login
  - setup_record_must_come_after_auth_middleware
  - marker_type_gives_422_annotation_alone_gives_500
  - lifespan_replaces_on_startup_hooks
  - testclient_hangs_when_a_startup_hook_raises
  - semicolon_in_field_comment_breaks_migrate
  - work_installable_ignores_queue_backend_and_is_in_memory
  - app_delete_and_options_ignore_auth_in_1_0_0
  - ctx_user_without_auth_middleware_raises
sources:
  - core:sillo/application.py
  - core:sillo/handlers/error_report.py
  - core:sillo/__main__.py
  - docs:v1.0/advanced/debugging.md
status: stable
---

## When

Something in a Sillo app fails, behaves differently from what the code seems to say, or
silently does nothing. Most Sillo bugs in practice are **wiring** bugs — order,
registration, configuration — not logic bugs, and the code looks right.

## Inspect first

1. The full error: the terminal error report (your frames, the failing line, locals),
   or the log line. Set `SILLO_TRACE=full` for the complete traceback.
2. `sillo version` (which Sillo, which extras really import) and `sillo routes` (what is
   actually registered, under which full path).
3. The bootstrap: every `app.use(...)`, `setup_*`/`app.install(...)`, `mount_router` and
   `lifespan=` — in order.

## How

Match the symptom first — the common ones have a known cause:
[symptoms.md](references/symptoms.md). The ones that cost the most time:

| Symptom | Cause |
|---|---|
| "No Session Middleware Installed"; every request anonymous | `SessionMiddleware` registered **before** `AuthenticationMiddleware` (last `use` is outermost) |
| login succeeds, next request 401; "No TortoiseContext is currently active" | `setup_record` called before the auth `app.use` lines |
| "default_connection for the model … cannot be None" | model not imported in the models package / `model_modules`; `UserManager` not bound with `contribute_to_class`; ORM used in a CLI command without `context()` |
| bad query value gives 500, missing required param gives 200 | marker without `type=` (and no `strict_validation=True`) |
| startup hooks, DB connect or scheduler never run | `SilloApp(lifespan=...)` replaces the hook list |
| `with TestClient(app)` hangs | a startup hook raised (mail SMTP unreachable, DB down); call `await app._startup()` to see it |
| DELETE route reachable without auth | `@app.delete(..., auth=...)` ignores `auth` in 1.0.0 — use a `Router` |
| jobs dispatched but never run | the in-process `SyncConnection` (setup_work default), no worker, or a worker on a different connection/queue |

**When nothing matches — isolate:**

1. Reproduce with `TestClient(app, raise_server_exceptions=True)` in a scratch test; the
   exception surfaces in the test instead of a 500.
2. Cut the app down: a fresh `SilloApp()` with only the route and the one middleware or
   subsystem involved. If it works there, the problem is registration/order.
3. Print the real middleware order with marker middleware (see `sillo-middleware`
   ordering.md) and the real routes with `app.print_routes()`.
4. Read the installed source for the API involved
   (`python -c "import sillo, os; print(os.path.dirname(sillo.__file__))"`) — docstrings
   explain intended behaviour, and several documented behaviours differ from 1.0.0.
5. Fix the cause, then add a test that fails without the fix.

## Compose

Ordering — `sillo-middleware`; error bodies — `sillo-errors`; logs and request ids —
`sillo-logging`; test harness — `sillo-testing`; migration failures — `sillo-migrations`;
queue failures (`sillo queue:failed`) — `sillo-queues`.

## Verify

The symptom's reproduction test passes, the full suite passes, and `sillo routes` /
startup behave as expected in `sillo dev`.

## Avoid

- Patching site-packages or monkeypatching Sillo internals to make a symptom disappear.
- "Fixing" order problems by moving code until it works without understanding the rule
  (last `app.use` is outermost) — the next middleware breaks it again.
- Broad `except Exception` around request parsing: it turns `await ctx.json()` TypeErrors
  into mysterious validation failures.
- Declaring victory on a status code; check the body and the side effect.
