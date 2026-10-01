---
name: sillo-errors
title: Errors & exception handlers
description: >-
  Sillo error handling: HTTPException, abort and not_found, exception handlers by type or
  status code, catch-all and server error handlers, custom 404 bodies, ORM exception
  mapping, and debug pages.
intents:
  - return a 404 when the order does not exist
  - make every error response JSON with the same shape
  - why am I getting this exception
  - hide stack traces in production
  - customize the 404 page
  - turn database integrity errors into 409s
  - add a custom exception for payment failures
capabilities: [errors]
related: [sillo-validation, sillo-responses, sillo-debugging, sillo-logging]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.HTTPException
  - sillo.NotFoundException
  - sillo.abort
  - sillo.not_found
  - sillo.application.SilloApp.add_exception_handler
  - sillo.record.register_db_exception_handlers
  - sillo.core.error.ServerErrorMiddleware
probes:
  - abort_raises_and_body_is_detail
  - http_exception_takes_status_code_not_status
  - error_body_shapes
  - catch_all_and_status_handlers
  - body_model_errors_are_http_422_and_marker_errors_are_request_validation_error
sources:
  - core:sillo/exceptions.py
  - core:sillo/exception_handler.py
  - core:sillo/core/error/handler.py
  - core:sillo/handlers/not_found.py
  - core:sillo/record/exceptions.py
  - docs:v1.0/guides/error-handling.mdx
status: stable
---

## When

Signalling a failure from a handler or dependency, shaping error bodies, handling your
own exception types, customising 404/500 responses, mapping ORM errors, or reading an
exception you did not expect. For diagnosing *why* something fails, pair with
`sillo-debugging`.

## Inspect first

- Existing `add_exception_handler` registrations and any `server_error_handler=` passed
  to `SilloApp`.
- The error body shape clients already rely on (tests, frontend code) before changing it.
- Whether `debug=True` is set (development only).

## How

**Raise to stop.**

```python
from sillo import abort, not_found
from sillo.exceptions import HTTPException

raise HTTPException(status_code=403, detail="Admins only")        # body: "Admins only"
abort(409, detail={"email": "already registered"})                # body: {"email": ...}
abort(401, detail="Sign in", headers={"WWW-Authenticate": "Bearer"})
not_found()                                                       # generic 404 body
```

`abort` and `not_found` raise; nothing after them runs. The body is `detail` serialised
as JSON — a bare string for a string, an object for a dict. `not_found(detail=...)` does
**not** show its detail unless `debug` is on; use `abort(404, detail=...)` when the client
should see it.

**Handlers** are registered by exception type **or status code**, and work as decorators:

```python
from sillo import HttpContext, json
from sillo.exceptions import HTTPException

class PaymentFailed(Exception):
    def __init__(self, reason: str):
        self.reason = reason

@app.add_exception_handler(PaymentFailed)
async def payment_failed(ctx: HttpContext, exc: PaymentFailed):
    return json({"error": "payment_failed", "reason": exc.reason}, status_code=402)

@app.add_exception_handler(HTTPException)
async def http_errors(ctx: HttpContext, exc: HTTPException):
    return json({"error": exc.detail, "status": exc.status_code}, status_code=exc.status_code,
                headers=exc.headers or None)

@app.add_exception_handler(404)            # also catches unmatched routes
async def not_found_page(ctx: HttpContext, exc):
    return json({"error": "not_found"}, status_code=404)
```

A handler receives `(ctx, exc)` and returns a response. **Catch-all:**
`add_exception_handler(Exception)` returns your own 500 body — log there (with the
request id) and return nothing internal. `SilloApp(server_error_handler=fn)` is the
last-resort hook with the same `(ctx, exc)` signature.

**Defaults** (debug off): unmatched route → 404
`{"status": 404, "error": "Not Found", "message": ...}`; unhandled exception → 500
`text/plain` "Internal Server Error", with a structured error report in the server log
(`SILLO_TRACE=off|app|full` controls its depth). `debug=True` serves a debug page with
source — development only.

**ORM errors:** `from sillo.record import register_db_exception_handlers` then
`register_db_exception_handlers(app)` maps `DoesNotExist`→404, `IntegrityError`→409,
Tortoise `ValidationError`→422, `OperationalError`→503 (`{"error", "detail"}` bodies).
Validation 422s from Sillo itself are covered in `sillo-validation`. Error-body design
notes: [design.md](references/design.md).

## Compose

- 422 validation errors take two paths (body models vs markers) — `sillo-validation`.
- Log once at the handler, with the request id — `sillo-logging`.
- Tracing an unexpected exception — `sillo-debugging`.
- Auth failures raise `AuthenticationFailed`/`PermissionDenied`, or use `useAuth`'s
  `unauthorized=`/`forbidden=` hooks — `sillo-auth`.

## Verify

Test the error paths, asserting the **body**, not only the status: a missing resource,
a conflict, an unhandled exception (with `TestClient(app, raise_server_exceptions=False)`
so the 500 is returned rather than raised in the test), and an unmatched route.

## Avoid

- `HTTPException(detail="…", status=404)`: the parameter is `status_code`.
- `return abort(...)` — it raises; returning nothing afterwards is dead code.
- Returning `json({"error": ...}, status_code=500)` from a broad `except Exception` inside
  handlers — register one catch-all handler instead so logging happens once.
- Leaking internals: `str(exc)` of database errors (the ORM handlers above include it)
  can reveal table and constraint names; write your own handler when that matters.
- Configuring a `not_found` settings block from older docs: it is not read in 1.0;
  register a 404 handler.
- Leaving `debug=True` on outside development.
