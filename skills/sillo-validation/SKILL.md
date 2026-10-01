---
name: sillo-validation
title: Validation
description: >-
  Validating Sillo inputs and outputs: Query/Header/Cookie/Path/Form/File markers with
  type= and constraints, Pydantic request_model bodies, response_model filtering,
  strict_validation, and the 422 error shapes.
intents:
  - validate the request body
  - make this query parameter required
  - limit page size to 100
  - validate an uploaded file field
  - hide the password hash from the response
  - return 422 when the input is wrong
  - accept a form post with a title and an image
capabilities: [validation, file_uploads]
related: [sillo-requests, sillo-responses, sillo-errors, sillo-openapi, sillo-dependency-injection]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.Query
  - sillo.Header
  - sillo.Cookie
  - sillo.Path
  - sillo.Form
  - sillo.File
  - sillo.UploadFile
  - sillo.RequestValidationError
  - sillo.ResponseValidationError
  - sillo.validation.ResponseModelValidator
probes:
  - request_model_injects_validated_body_and_422s
  - query_marker_validates_and_422_names_location
  - marker_type_gives_422_annotation_alone_gives_500
  - strict_validation_turns_annotation_errors_into_422
  - response_model_filters_returned_dict_but_not_built_response
  - required_header_without_type_is_500_unless_strict
  - body_and_query_422_shapes_differ
  - body_model_errors_are_http_422_and_marker_errors_are_request_validation_error
  - request_model_parses_json_even_for_form_posts
sources:
  - core:sillo/validation/fields.py
  - core:sillo/validation/compiler.py
  - core:sillo/exception_handler.py
  - core:sillo/application.py
  - docs:v1.0/guides/validation/index.md
  - docs:v1.0/guides/request-parameters.mdx
  - docs:v1.0/guides/validation/forms-and-files.md
status: stable
---

## When

Any input that should be checked, converted or documented: JSON bodies, query strings,
headers, cookies, path segments, form fields, uploaded files; and any output that must
not leak fields. Also "why do I get 422" and "why does bad input give a 500".

## Inspect first

- Whether the app sets `SilloApp(strict_validation=True)` — it changes what an
  unvalidated marker does (see Avoid).
- Existing Pydantic schemas (often `app/schemas.py`) — reuse them.
- Any `add_exception_handler(RequestValidationError, …)` that reshapes 422 bodies.

## How

**The type lives on the marker.** Validation and the OpenAPI schema come from
`type=` and the constraint keywords on the marker, not from the annotation:

```python
from sillo import HttpContext, Header, Path, Query

@app.get("/products")
async def index(
    ctx: HttpContext,
    page=Query(1, type=int, ge=1),
    per_page=Query(20, type=int, ge=1, le=100),
    q=Query(None, type=str, max_length=100),
    tags=Query(None, type=list[str]),                 # ?tags=a&tags=b
    api_key=Header(alias="X-API-Key", type=str, required=True),
):
    ...
```

Markers: `Query`, `Header` (underscores match dashes; `alias=` for exact names),
`Cookie`, `Path`, `Form`, `File`. Keywords: `type`, `required`, `alias`, `gt/ge/lt/le`,
`min_length/max_length`, `pattern`, `multiple_of`, `description`, `example`,
`deprecated`. Annotations are welcome for readability but are not what validates.

**JSON bodies** — declare the model once, on the route:

```python
from pydantic import BaseModel, EmailStr, Field
from sillo import HttpContext, created

class SignupIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)

class UserOut(BaseModel):
    id: int
    email: str

@app.post("/signup", request_model=SignupIn, response_model=UserOut)
async def signup(ctx: HttpContext, payload):     # first plain parameter = the model
    user = await User.objects.create_user(email=payload.email, username=payload.email,
                                          password=payload.password)
    return user.to_dict()                          # filtered to id + email
```

The validated instance is injected into the first parameter after `ctx` that has no
marker or `Depend`, and is also `ctx.validated_data`. It composes with markers and
`Depend` in the same signature.

**Forms and files** use markers, not `request_model` (a `request_model` always parses
JSON):

```python
from sillo import File, Form, HttpContext

@app.post("/posts")
async def create_post(ctx: HttpContext, title=Form(type=str, min_length=1), image=File()):
    data = await image.read()      # an UploadedFile: .filename, .content_type, .read()
    ...
```

**Outputs.** `response_model=Model` (or `list[Model]`) validates and filters **returned
values** — undeclared fields are dropped. A response you build (`json(...)`) is sent as
is.

**Errors.** Invalid input is a 422 whose body says where it failed. The shapes differ:
body errors are a bare list (`[{"loc": ["title"], …}]`), parameter errors are wrapped
(`{"detail": [{"loc": ["query", "limit"], …}]}`). To give clients one shape, register a
handler — see [errors.md](references/errors.md).

## Compose

- Reading unvalidated request data: `sillo-requests`.
- 422 formatting and other exception handlers: `sillo-errors`.
- Parameters and models appear in the OpenAPI document: `sillo-openapi`.
- Validation inside a reusable dependency (paging, filters): `sillo-dependency-injection`
  — markers work in dependencies too.
- Storing uploaded files: `sillo-storage`.

## Verify

For each validated route: a valid request succeeds, and a missing/out-of-range value
returns **422** (not 500) with the expected `loc`. Assert the response body of a
`response_model` route contains no undeclared fields.

## Avoid

- `page: int = Query(1)` without `type=` (and without `strict_validation=True`): a bad
  value raises inside the handler and returns **500**, and `Query(...)` does not make it
  required. Put `type=` on every marker, or set `SilloApp(strict_validation=True)`.
- A required `Header(...)`/`Cookie(...)` without `type=`: missing → 500, not 422.
- `request_model` for form or multipart posts — use `Form()`/`File()` markers.
- Relying on `response_model` to hide fields from a `json(...)` you built yourself.
- FastAPI habits: `Body(...)`, `Depends`, annotations such as `q: str | None = None`
  becoming query parameters — Sillo binds only markers, path params and `Depend`.
