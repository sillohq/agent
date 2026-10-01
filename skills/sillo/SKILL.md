---
name: sillo
title: Sillo
description: >-
  Start here for any Python project using the Sillo framework (sillo-framework, `from sillo
  import …`). Checks the installed version, sets the ground rules, and routes to the focused
  sillo-* skills.
intents:
  - add a feature to my Sillo app
  - how do I do this in Sillo
  - is this a Sillo project
  - which Sillo version is this
  - does Sillo have a way to do this
capabilities:
  - distributed_locks
  - telemetry
  - html_templating
  - notifications
  - localization
  - queue_brokers
related: [sillo-application, sillo-routing, sillo-record, sillo-auth, sillo-debugging]
requires: []
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.SilloApp
  - sillo.HttpContext
sources:
  - core:sillo/__init__.py
  - core:sillo/__main__.py
  - core:CHANGELOG.md
  - docs:v1.0/cli/discovery.md
status: stable
---

Sillo is an async Python web framework (`pip install sillo-framework`, imported as
`sillo`) whose ORM, auth, queues, scheduler, mail, storage and WebSockets share one
application object. These skills describe **Sillo 1.x**. They were written from the
framework's source and checked by executing it; where the official docs disagree with
the code, the skills follow the code.

## When

Load this skill first whenever the project uses Sillo, before loading a focused skill.
It is also the place to answer "does Sillo have X?" — see
[not-in-sillo.md](references/not-in-sillo.md) before building on an API that sounds
plausible.

## Inspect first

1. **Is it Sillo?** `sillo-framework` in `pyproject.toml` / `requirements*.txt` / a lock
   file, or `from sillo import …` in the code. A project that only has `sillo-start`
   was scaffolded with it but still runs on `sillo-framework`.
2. **Which version is installed?** Run the bundled script with the project's interpreter:
   `.venv/bin/python <this skill's directory>/scripts/sillo_project.py` (or
   `uv run python …`). It prints the installed Sillo version, where its source lives,
   which official packages and optional extras are present, and the application's
   import string — without importing the project. `sillo version` gives the same
   version and feature list from inside the project.
3. **What does the project already do?** Read the application factory (usually
   `app/main.py`, `app/bootstrap.py` or whatever `[tool.sillo] app` names), its
   middleware registration, `database/models`, and existing tests before adding
   anything. Match the structure that is there.

If the installed version is not 1.x, read [versions.md](references/versions.md) first:
0.x has a different handler signature and most examples here will not apply.

## How

Working rules for every Sillo change:

- **Never invent a Sillo API.** Every import in these skills exists in 1.0. If you need
  something a skill does not show, confirm it in the installed source before using it —
  see [source-fallback.md](references/source-fallback.md). Do not port Django, FastAPI,
  Flask, Starlette or Laravel idioms by analogy: several of them almost exist in Sillo
  under a different name or with different semantics.
- **Handlers take one context.** `async def handler(ctx: HttpContext, …)` and return a
  value or a response builder (`json`, `redirect`, …). There is no `request`/`response`
  pair in 1.x.
- **Registration order is behaviour.** `app.use()` makes the *last* registered middleware
  the outermost. Auth must be registered before sessions; `setup_record` installs its own
  per-request middleware. See `sillo-middleware`.
- **Wiring lives in one place.** Subsystems are installed on the app (`setup_record`,
  `setup_mail`, `app.install(...)`) and stored on `app.state`; the `sillo` CLI finds
  commands by looking there.
- **Prefer the project's architecture.** Extend its bootstrap, routers and models rather
  than restructuring. Make the smallest coherent change and leave unrelated code alone.
- **Async all the way.** Handlers, dependencies, jobs and model calls are coroutines.
  Blocking I/O in a handler stalls every request on that worker; use
  `sillo.helpers.concurrency.run_in_threadpool` for unavoidable sync calls.

Which skill to load:

| The request is about | Load |
|---|---|
| app setup, config, `.env`, startup/shutdown, running, deploying | `sillo-application` |
| routes, routers, path params, redirects, static files | `sillo-routing` |
| reading the request: body, form, files, headers, cookies, client IP | `sillo-requests` |
| status codes, JSON/HTML/files, streaming, SSE, cookies, headers | `sillo-responses` |
| input validation, request/response models, 422s | `sillo-validation` |
| `Depend`, shared per-request resources | `sillo-dependency-injection` |
| middleware, ordering, CORS placement, gzip, request IDs | `sillo-middleware` |
| exceptions, error pages, custom error bodies | `sillo-errors` |
| models, fields, relationships, queries, transactions, seeding | `sillo-record` |
| schema changes, `sillo db:*` | `sillo-migrations` |
| login, register, JWT, sessions-as-auth, API keys, protected routes | `sillo-auth` |
| user model, passwords, `sillo user:*` | `sillo-users` |
| roles, permissions, groups, "only admins" | `sillo-authorization` |
| the session store itself | `sillo-sessions` |
| CORS, CSRF, security headers, HTTPS, signing/encryption | `sillo-security` |
| throttling, "5 attempts per minute" | `sillo-rate-limiting` |
| caching results or responses | `sillo-cache` |
| events and listeners | `sillo-events` |
| durable background jobs, workers, retries | `sillo-queues` |
| fire-and-forget work in the web process | `sillo-background-tasks` |
| cron, "every night", intervals | `sillo-scheduler` |
| sending email | `sillo-mail` |
| file uploads to disk or S3, signed URLs | `sillo-storage` |
| WebSocket endpoints | `sillo-websockets` |
| rooms, presence, broadcasting to many sockets | `sillo-wire` |
| pagination | `sillo-pagination` |
| OpenAPI, Swagger/ReDoc/Scalar docs | `sillo-openapi` |
| tests, `TestClient` | `sillo-testing` |
| `sillo` CLI, custom console commands | `sillo-cli` |
| logging, request IDs, error reports | `sillo-logging` |
| something is broken and you do not know why | `sillo-debugging` |
| calling external HTTP APIs | `sillo-http-client` |
| string/retry/network/file helpers | `sillo-helpers` |
| React/Vue pages via Inertia | `sillo-inertia` |
| "sign in with Google/GitHub" | `sillo-oauth` |
| GraphQL APIs | `sillo-graphql` |
| an admin panel | `sillo-admin` |
| creating a new project | `sillo-scaffolding` |

Most real requests need two or three of these; each skill's Compose section names the
usual partners.

## Compose

This skill composes with everything. When a feature spans subsystems — "email on signup
in the background" is `sillo-auth` + `sillo-queues` + `sillo-mail` — load each, and
wire them through the application's existing bootstrap rather than creating a second one.

## Verify

- Run the project's tests (`pytest`, usually through `uv run pytest`). Sillo's
  `TestClient` must be used as a context manager to run startup hooks.
- `sillo routes` lists every route the application registers — the quickest check that a
  new route, router mount or prefix landed where intended.
- `sillo version` confirms which optional extras are really installed.
- Import the application once (`python -c "import app.main"`) after wiring changes;
  mis-ordered setup usually fails at import or first request, not at edit time.

## Avoid

- Guessing an import path. `sillo.graphql`, `sillo.wire`, `sillo.admin`, `@app.route`,
  `app.websocket`, `Request`, `request.json()` and `silloApp` do not exist in 1.x.
- Trusting a remembered Sillo 0.x example: `handler(request, response)`,
  `response.json(...)` and the `Responder` were removed in 1.0.
- Building a feature Sillo does not have without saying so. Distributed locks,
  metrics/tracing, server-side templates, notifications, translations and non-Redis
  queue brokers are not in Sillo 1.x — [not-in-sillo.md](references/not-in-sillo.md)
  says what to use instead.
- Editing files under `site-packages/sillo`. Read them; never patch the framework to make
  application code work.
