# Designing error responses

## One envelope

Pick one shape and route every error through it:

```python
from sillo import HttpContext, RequestValidationError, json
from sillo.exceptions import HTTPException


def problem(code: str, message: str, status: int, **extra):
    return json({"error": {"code": code, "message": message, **extra}}, status_code=status)


@app.add_exception_handler(HTTPException)
async def http_error(ctx: HttpContext, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, str) else "Request failed"
    extra = exc.detail if isinstance(exc.detail, dict) else {}
    return problem(f"http_{exc.status_code}", detail, exc.status_code, **extra)


@app.add_exception_handler(RequestValidationError)
async def invalid_parameter(ctx: HttpContext, exc: RequestValidationError):
    return problem("validation_failed", "Invalid input", 422, fields=exc.errors)


@app.add_exception_handler(422)
async def invalid_body(ctx: HttpContext, exc):
    return problem("validation_failed", "Invalid input", 422, fields=exc.detail)


@app.add_exception_handler(Exception)
async def unhandled(ctx: HttpContext, exc: Exception):
    request_id = getattr(ctx.state, "request_id", None)
    logger.exception("unhandled error on %s [%s]", ctx.path, request_id)
    return problem("internal_error", "Something went wrong", 500, request_id=request_id)
```

Handlers for more specific types win over `Exception`. Test each branch.

## Choosing statuses

| Situation | Status |
|---|---|
| malformed / out-of-range input | 422 |
| conflicts with current state (duplicate email, stale version) | 409 |
| not authenticated | 401 (+ `WWW-Authenticate` for bearer APIs) |
| authenticated but not allowed | 403 — or 404 to hide existence |
| rate limited | 429 (+ `Retry-After`) |
| dependency down, retry later | 503 |
| your bug | 500 |

## Domain exceptions

Raise domain exceptions from services and translate them once at the edge:

```python
class InsufficientStock(Exception):
    def __init__(self, sku: str):
        self.sku = sku


@app.add_exception_handler(InsufficientStock)
async def out_of_stock(ctx: HttpContext, exc: InsufficientStock):
    return problem("insufficient_stock", f"{exc.sku} is out of stock", 409, sku=exc.sku)
```

Services then stay free of HTTP concerns and remain callable from jobs and scripts.
