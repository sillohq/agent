# Validation error shapes

What Sillo 1.0 returns for invalid input, verified against the framework:

```text
POST /items  (request_model, body invalid)
422  [{"type": "string_too_short", "loc": ["title"], "msg": "...", "input": "ab", ...}]

POST /items  (body is not JSON)
422  [{"loc": ["body"], "msg": "Request body is not valid JSON", "type": "json_invalid"}]

GET /items?limit=500  (Query(type=int, le=100))
422  {"detail": [{"loc": ["query", "limit"], "msg": "...", "type": "less_than_equal", "input": "500"}]}

GET /secure  (Header(alias="X-API-Key", type=str, required=True), header missing)
422  {"detail": [{"loc": ["header", "X-API-Key"], "msg": "Field required", "type": "missing"}]}
```

## One shape for clients

The two kinds of failure travel different paths, so a single handler does not see both:

| Failure | Raised as | Catch with |
|---|---|---|
| `request_model` body invalid or not JSON | `HTTPException(422, detail=[...])` | `add_exception_handler(422)` |
| a marker (`Query`, `Header`, `Form`, …) invalid | `RequestValidationError` (`.errors` is a list) | `add_exception_handler(RequestValidationError)` |

Register both and emit the same body:

```python
from sillo import HttpContext, RequestValidationError, json

def validation_body(errors):
    return json({"error": "validation_failed", "fields": errors}, status_code=422)

@app.add_exception_handler(RequestValidationError)
async def marker_errors(ctx: HttpContext, exc: RequestValidationError):
    return validation_body(exc.errors)

@app.add_exception_handler(422)
async def body_errors(ctx: HttpContext, exc):
    return validation_body(exc.detail)
```

Assert both paths in a test: one request with an invalid body, one with an invalid query
parameter.

## Business-rule failures

422 means "this value is invalid". A conflict with existing state ("email already
registered") is a 409, raised yourself:

```python
from sillo import abort

if await User.objects.get_by_email(payload.email):
    abort(409, detail={"email": "already registered"})
```

`abort(status, detail=...)` accepts a dict, which keeps error bodies structured.
