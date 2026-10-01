---
name: sillo-dependency-injection
title: Dependency injection
description: >-
  Sillo's Depend(): injecting services, the user or parsed parameters, get_context=True, yield dependencies with cleanup, router and app-wide dependencies, test overrides.
intents:
  - inject the database session into handlers
  - share the pagination parameters across endpoints
  - get the current user through a dependency
  - clean up a resource after the request
  - swap a dependency for a fake in tests
  - run a check before every route in this router
capabilities: [dependency_injection]
related: [sillo-validation, sillo-auth, sillo-testing, sillo-requests]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.Depend
  - sillo.application.SilloApp.override
  - sillo.work.dependency.scheduler
  - sillo.work.dependency.queue_connection
probes:
  - depend_get_context_defaults_to_false
  - dependency_can_declare_extractors
  - yield_dependency_runs_finally_not_code_after_bare_yield
  - dependency_override_context_manager
  - dependencies_are_not_cached_per_request
  - router_and_app_level_dependencies_run_for_every_route
  - dependency_raising_http_exception_short_circuits
sources:
  - core:sillo/core/dependencies/base.py
  - core:sillo/application.py
  - core:sillo/work/dependency.py
  - core:CHANGELOG.md
  - docs:v1.0/guides/dependency-injection.md
status: stable
---

## When

A handler needs a value it should not build itself — a service, a repository, a
settings object, the current account, parsed paging/filter parameters — or the same
check must run before several routes, or a test needs to replace a collaborator.
Behaviour that applies to every request regardless of the handler is middleware
(`sillo-middleware`), not a dependency.

## Inspect first

- Existing dependency functions (often `app/dependencies.py`) and how they are declared
  — especially whether they take a context parameter.
- The installed version: before 1.0.0rc1 every dependency received `ctx` first; from rc1
  only those declared with `get_context=True` do.

## How

`Depend(fn)` marks a parameter; Sillo calls `fn` and binds the result. A dependency's
own parameters are resolved the same way as a handler's — markers, nested `Depend` —
and **nothing is passed positionally unless you ask for the context**:

```python
from sillo import Depend, HttpContext, Query

def get_settings():                                   # needs nothing
    return settings

def paging(page=Query(1, type=int, ge=1), per_page=Query(20, type=int, le=100)):
    return {"offset": (page - 1) * per_page, "limit": per_page}

def current_tenant(ctx: HttpContext):                 # needs the request
    return ctx.headers.get("x-tenant", "default")

@app.get("/items")
async def index(
    ctx: HttpContext,
    cfg=Depend(get_settings),
    page=Depend(paging),
    tenant=Depend(current_tenant, get_context=True),  # ctx passed as first argument
):
    ...
```

**Cleanup.** A generator dependency yields its value; put teardown in `finally` —
after the handler the generator is *closed*, so code after a bare `yield` never runs:

```python
async def unit_of_work():
    tx = await begin_transaction()
    try:
        yield tx
    finally:
        await tx.close()
```

**Failing early.** Raise `HTTPException` (or call `abort(...)`) inside a dependency to
stop the request before the handler runs.

**Everywhere at once.** `Router(prefix=..., dependencies=[Depend(check, get_context=True)])`
and `SilloApp(dependencies=[...])` run the dependencies for every route they own —
useful for side-effect checks; their return values are not injected anywhere.

**Framework providers.** `sillo.work.dependency` has `scheduler`, `queue_connection`,
`events` and `default_queue`, each reading `ctx.base_app` — declare them with
`get_context=True`: `conn=Depend(queue_connection, get_context=True)`.

**Overrides in tests:**

```python
with app.override(get_settings, lambda: test_settings):
    client.get("/items")                 # every Depend(get_settings) uses the fake
app.dependency_overrides[get_settings] = lambda: test_settings   # suite-wide
```

Overrides match the exact function object passed to `Depend` and reach nested
dependencies too.

## Compose

- Markers inside dependencies (`Query`, `Header`, …) — `sillo-validation`.
- The authenticated user comes from `AuthenticationMiddleware` as `ctx.user`; a
  dependency is the place to load the *domain* account from it — `sillo-auth`.
- Process-wide resources (pools, clients) are created at startup and stored on
  `app.state`; a dependency with `get_context=True` hands them out — `sillo-application`.
- Overrides in the test suite — `sillo-testing`.

## Verify

A `TestClient` request exercises the whole tree. Check the failure path too (a
dependency that raises returns its status). For generator dependencies, assert the
cleanup ran (a flag, a closed connection).

## Avoid

- `def dep(ctx): …` declared as plain `Depend(dep)` on 1.0.0rc1+: `ctx` is not passed,
  so the call fails or the parameter silently gets its default. Add `get_context=True`.
- Expecting per-request caching: Sillo calls a dependency each time it is declared, even
  twice in one request. Share one object by depending on a single wrapper, or stash it on
  `ctx.state`.
- `Depend(fn, use_cache=False)`, `Depends(...)`, `scope="request"` — none exist.
- Code after `yield` without `try/finally`: it never runs.
- Doing per-process setup in a dependency (building a pool per request); do it at
  startup.
- Using `ctx.path` inside a router-level dependency for the full URL: inside a mounted
  router it is relative to the mount (`ctx.scope["root_path"]` holds the prefix).
