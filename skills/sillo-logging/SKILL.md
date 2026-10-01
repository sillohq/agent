---
name: sillo-logging
title: Logging, request IDs & error reports
description: >-
  Observability in Sillo: Python logging and create_logger, request IDs with RequestId
  middleware, the terminal error report and SILLO_TRACE, dev request logs, and what Sillo
  does not provide (metrics, tracing).
intents:
  - add request ids to every log line
  - log every request
  - configure logging for production
  - make error logs show the request
  - add tracing or metrics
capabilities: [logging, telemetry]
related: [sillo-middleware, sillo-errors, sillo-debugging]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.logging.create_logger
  - sillo.http.lifecycle.RequestId
  - sillo.http.lifecycle.RequestIdMiddleware
  - sillo.http.lifecycle.get_request_id_from_request
probes:
  - first_party_middleware_wiring
sources:
  - core:sillo/logging.py
  - core:sillo/http/lifecycle/middleware.py
  - core:sillo/handlers/error_report.py
  - core:sillo/dev.py
  - docs:v1.0/guides/request-lifecycle.md
  - docs:v1.0/advanced/debugging.md
status: stable
---

## When

Making the app observable: structured logs, request correlation, error output, request
logging; or a request for metrics/tracing (which Sillo does not ship — see How).

## Inspect first

Existing logging configuration (`logging.basicConfig`, `dictConfig`), whether
`RequestId()` is installed, and the deployment's log collector expectations (JSON?).

## How

Sillo logs through the standard `logging` module under the `sillo` namespace
(`sillo.record`, `sillo.work`, …). Configure logging as for any Python app; for a quick
setup `from sillo.logging import create_logger` returns a queue-backed logger
(`create_logger("myapp", log_level=logging.INFO, log_file="storage/app.log")`).

**Request IDs:**

```python
from sillo.http.lifecycle import RequestId

app.use(RequestId())      # reads X-Request-ID or generates one; echoes it on the response
```

Inside handlers and middleware it is `ctx.state.request_id`; add it to log calls (or a
`logging.Filter` that reads a contextvar you set in a small middleware) and return it in
error bodies so users can quote it.

**Errors.** An unhandled exception logs a compact report of *your* frames (source line,
locals with secret-looking names masked). `SILLO_TRACE=off|app|full` controls its depth;
it is printed when stderr is a terminal, otherwise one structured line goes to the
logger. `debug=True` additionally serves the debug page — development only.

**Request logs.** `sillo dev` prints a compact access log. In production use the ASGI
server's access log (`uvicorn --access-log`) or a middleware:

```python
import logging, time
from sillo import HttpContext

access = logging.getLogger("myapp.access")

async def access_log(ctx: HttpContext, call_next):
    start = time.perf_counter()
    response = await call_next()
    access.info("%s %s %s %.1fms rid=%s", ctx.method, ctx.url.path, response.status_code,
                (time.perf_counter() - start) * 1000, getattr(ctx.state, "request_id", "-"))
    return response
```

Register it after `RequestId()` so it runs inside it (last `use` is outermost).

**Metrics and tracing are not built in.** Add OpenTelemetry's ASGI middleware as raw
middleware (`app.use(OpenTelemetryMiddleware, raw=True)`) or export timings from your own
middleware. Do not invent a `sillo.telemetry` module.

## Compose

Middleware placement — `sillo-middleware`; error bodies with request ids —
`sillo-errors`; reading an error report — `sillo-debugging`.

## Verify

`TestClient` request: response has `X-Request-ID`; a log record (captured with pytest's
`caplog`) contains it.

## Avoid

- Logging request bodies, `Authorization` headers or passwords.
- Logging the same exception in the handler, middleware and catch-all.
- Trusting client-supplied `X-Request-ID` values in logs without bounding them.
- Mounted routers: `ctx.path` there is relative to the mount — log `ctx.url` in app-level
  middleware (which sees the full path) instead.
