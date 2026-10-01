---
name: sillo-openapi
title: OpenAPI & API docs
description: >-
  Sillo's OpenAPI document and docs UIs: /openapi.json, Atlas, Swagger, ReDoc, Scalar via docs=[...], summaries, tags, response models, auth schemes, hiding routes.
intents:
  - document the API
  - add Swagger UI
  - hide these internal routes from the docs
  - show the bearer token auth in the API docs
  - change the docs URL
  - generate a client from the OpenAPI spec
capabilities: [openapi]
related: [sillo-validation, sillo-routing, sillo-auth, sillo-security]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.openapi.ui.Swagger
  - sillo.openapi.ui.ReDoc
  - sillo.openapi.ui.Scalar
  - sillo.openapi.ui.Atlas
  - sillo.openapi.ui.DocsUI
  - sillo.openapi.config.OpenAPIConfig
  - sillo.openapi.models.Contact
  - sillo.openapi.models.License
  - sillo.openapi.models.Server
probes:
  - openapi_document_docs_uis_and_auth_schemes
sources:
  - core:sillo/application.py
  - core:sillo/openapi/ui.py
  - core:sillo/openapi/_builder.py
  - docs:v1.0/guides/openapi/index.md
  - docs:v1.0/guides/openapi/documentation-ui.md
  - docs:v1.0/guides/openapi/authentication-documentation.md
status: stable
---

## When

Improving or controlling the generated API documentation: titles, descriptions, tags,
response schemas, documented security, docs UI choice and URLs, hiding routes, exporting
the spec for client generation.

## Inspect first

`SilloApp(...)` arguments (`title`, `version`, `description`, `docs`, `openapi_url`,
`auth`, `strict_security`), route decorator metadata, and whether `Shield` is installed
(its default CSP blocks the docs UIs' CDN scripts).

## How

The document is built at startup from routes, markers, `request_model`/`response_model`
and `useAuth` gates — there is nothing separate to maintain.

```python
from sillo import SilloApp
from sillo.openapi.ui import ReDoc, Scalar, Swagger

app = SilloApp(
    title="Shop API",
    version="2.1.0",
    description="Orders, products and customers.",       # default text is generic
    docs=[Swagger(path="/docs"), Scalar(path="/reference")],  # default: Atlas at /docs, ReDoc at /redoc
    openapi_url="/openapi.json",
    auth=[JWTAuthBackend(secret_key=settings.jwt_secret, identifier="sub")],
    auth_user_model=User,
    strict_security=True,        # fail the build if a route names an unknown scheme
)
```

`docs=[]` removes the UIs but keeps `/openapi.json`. Any object with a `path` and a
`render(ctx)` method can be a UI (`sillo.openapi.ui.DocsUI`).

**Per route:**

```python
@router.post(
    "/orders",
    summary="Place an order",
    description="Charges the card on file and returns the order.",
    tags=["orders"],
    request_model=OrderIn,
    response_model=OrderOut,
    responses={201: OrderOut, 409: ConflictOut, 422: None},
    operation_id="orders.create",
    auth=useAuth(schemes=["bearerAuth"]),       # documented as the route's security
)
```

`Router(prefix=..., tags=[...])` tags every route under it; `exclude_from_schema=True` on
a route (or router) hides it; `deprecated=True` marks it. Marker constraints
(`ge`, `le`, `max_length`, `description=`, `example=`) appear as parameter schemas.

Security schemes come from the backends passed to `SilloApp(auth=[...])`: `bearerAuth`,
`sessionCookie`, `apiKeyHeader`; a route's `useAuth(schemes=[...])` becomes its
`security`. Behind a proxy prefix, `root_path=` fills the `servers` block.

Export for client generation: `curl localhost:8000/openapi.json > openapi.json`.

## Compose

Schemas come from `sillo-validation`; gates from `sillo-auth`; CSP for the docs page
from `sillo-security`.

## Verify

`GET /openapi.json` in a test: assert the path, its `tags`, `parameters`, response
schema and `security`. Open `/docs` in a browser.

## Avoid

- `Shield()` defaults with the docs UIs: the CSP (`script-src 'self'`) blocks their CDN
  scripts and the page renders blank. Allow the CDN in `csp_policy` or serve docs only
  in development.
- Documenting auth by hand with `security=[...]` while the route has no `useAuth` —
  the document then claims protection the app does not enforce; prefer the gate.
- Returning a built `json(...)` and expecting `response_model` to shape it — it documents
  the model but does not filter the body.
- Exposing `/docs` publicly in production when the API is private: `docs=[]` there.
