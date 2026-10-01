# Symptoms and causes (sillo-framework 1.x)

Each entry was reproduced against sillo-framework 1.0.0.

## Startup and configuration

| Symptom | Cause | Fix |
|---|---|---|
| startup hooks never run; DB not connected; scheduler idle | `SilloApp(lifespan=...)` replaces `on_startup`/`on_shutdown` and every `setup_*` hook | use hooks, or call `await app._startup()` / `_shutdown()` inside the lifespan |
| app will not start; `ConnectionRefusedError` at startup | `setup_mail` connects to SMTP at startup | fix SMTP settings, or `MAIL_SUPPRESS_SEND=true` where there is no SMTP |
| settings from `.env` missing | the `.env` is outside the project root, the variable is already exported (real env wins), or `SILLO_ENV_FILE=` is set empty | `sillo.env.find_env()` shows the file used |
| `ImportError: cannot import name 'silloApp'` | renamed in 0.0.2a2 | `SilloApp` |
| `sillo` shows no `db:*` / `user:*` commands | app not discovered, or no `setup_record` | set `[tool.sillo] app`; `sillo routes` shows what was imported |

## Routing and requests

| Symptom | Cause | Fix |
|---|---|---|
| `AssertionError: Route handler must be callable` at import | stacked `@app.get` + `@app.post`; app decorators return `None` | one decorator, `Route(path, h, methods=[...])`, or a `Router` |
| 404 for `/items/` but `/items` works | `trailing_slash="strict"` (default) | `SilloApp(trailing_slash="redirect")` or use the registered form |
| 404/422 for `/users/abc` | converter `{id:int}` did not match | expected; validate input |
| `TypeError: 'coroutine' object is not callable` / empty body | `await ctx.json()` with parentheses | `await ctx.json` |
| `ValueError: Authentication middleware required to use ctx.user` | no `AuthenticationMiddleware` | install it (see `sillo-auth`) or do not read `ctx.user` |
| 500 for a bad query param; missing required param returns 200 | marker without `type=` | `Query(..., type=int, required=True)` or `strict_validation=True` |
| 422 body shapes differ between endpoints | body-model errors are `HTTPException(422)` lists; marker errors are `{"detail": [...]}` | register handlers for both (see `sillo-validation`) |
| `ctx.path` lacks the router prefix | inside a mounted router the path is relative | full path is `ctx.scope["root_path"] + ctx.path`; log in app-level middleware |
| client IP is attacker-chosen | `ctx.get_client_ip()` trusts `X-Forwarded-For` | `sillo.helpers.network.get_client_ip(..., trusted_proxies=[...])` |

## Middleware, auth and sessions

| Symptom | Cause | Fix |
|---|---|---|
| middleware "not running" | registered on a different scope (route vs router vs app), short-circuited by an outer layer, a raw ASGI factory passed where dispatch is expected (500 `missing 1 required positional argument: 'send'`), or it forgot `return await call_next()` | print the order with marker middleware |
| "No Session Middleware Installed" | session registered before auth | auth first, then session |
| login OK, next request 401; "No TortoiseContext is currently active" | `setup_record` before the auth middleware | call `setup_record` after the `app.use` lines |
| JWT verifies but user never loads | `JWTAuthBackend` without `identifier="sub"` | add it |
| session resets every request on localhost | `session_cookie_secure=True` (default) over http | `False` outside production |
| DELETE/OPTIONS route public despite `auth=` | 1.0.0 bug in `app.delete`/`app.options`/`add_route(path=...)` | register on a `Router` or as `Route(..., auth=...)` |
| every route 403 with CSRF on | client not sending `X-CSRFToken` | read the `csrftoken` cookie and send the header |
| browser shows CORS error for a 401 | CORS registered inside auth | register CORS later (outer) |
| `/docs` blank page | `Shield()` default CSP blocks the CDN script | extend `csp_policy` |
| rate limit never triggers behind a proxy / by attackers | default key follows `X-Forwarded-For` | `key_func` with trusted proxies |
| `RateLimit` on a route → 500 | it is raw ASGI middleware | `router.use(RateLimit(...))` or a `check()` wrapper |

## Database and migrations

| Symptom | Cause | Fix |
|---|---|---|
| "default_connection for the model … cannot be None" | model module not imported / not in `model_modules`; manager not bound; CLI command without `context()` | import in models `__init__`, `contribute_to_class`, add `context()` |
| extra user columns never created | `sillo.users` in `model_modules` displaced your `User` | remove it |
| `db:migrate`: table already exists | `generate_schemas=True` created tables at startup | `generate_schemas=False`; `db:migrate --fake` only to adopt an existing schema |
| `db:migrate`: `OperationalError … incomplete input` | a `;` in a field's `#:` comment | remove it; check `sillo db:sql` |
| `db:make`: "No model changes" but you changed a model | model not imported, or not in the registered modules | fix registration |
| `AttributeError: 'coroutine' object has no attribute 'save'` | `Model.update_or_create` update path | fetch, `await update_from_dict`, `save` |
| money shows `6.7E+2` | SQLite returns Decimals in exponent form | `format(value, "f")` |
| "database is locked" | SQLite with several processes (workers, app + worker) | Postgres/MySQL, or one writer |
| model events never fire | `HasEvents` listeners only run on `fire_event` | Tortoise `post_save` signals |

## Background work

| Symptom | Cause | Fix |
|---|---|---|
| jobs queued but never run | `SyncConnection` (setup_work always makes one), no worker, or app and worker on different connections | `connection_for(QUEUE_URL)` + `Job.on_connection`, run `sillo queue:work` with the same `QUEUE_URL` |
| job goes to `default` not its queue | `queue = "..."` attribute is not used for routing | `MyJob.on_queue("...")` |
| no retries | `tries`/`backoff`/`failed()` unused by the worker | `QRetryMiddleware` in `middleware` |
| job ran twice | Redis at-least-once (visibility timeout) | make `handle` idempotent |
| worker: `Cannot resolve job class` | job module not importable in the worker | import `app.jobs` in the bootstrap |
| `RuntimeError: … cannot be called while an event loop is running` | `dispatch_blocking`/`dispatch_sync` in async code | `await Job.dispatch(...)` / `perform_now` |
| scheduled job runs N times | scheduler started in each of N processes | one `sillo schedule:run` process |
| `'ScheduledJob' object is not callable` | calling a decorated schedule function | keep the plain function; decorators return `ScheduledJob` |
| Ctrl-C does not stop the dev server | an in-process `QueueWorker` took the SIGINT handler | run workers as separate processes |

## Tests

| Symptom | Cause | Fix |
|---|---|---|
| `app.state` empty / DB not connected in tests | `TestClient(app)` without `with` | `with TestClient(app) as client:` |
| test hangs at the client fixture | a startup hook raised (1.0.0 TestClient hangs) | call `await app._startup()` to see the exception |
| background effect not visible | assertion ran first | `await bt.wait()` / poll |
| tests read developer settings | `.env` auto-loaded | `SILLO_ENV_FILE=""` |

## Integrations

| Symptom | Cause | Fix |
|---|---|---|
| WebSocket handshake never completes under uvicorn | neither `websockets` nor `wsproto` installed | `pip install websockets` |
| `HTTPClient()` → `TypeError: Invalid type for url` | no base URL | pass one |
| API error body treated as data | `HTTPClientConfig(raise_for_status=False)` default | set `True` |
| storage `PolicyRefused` from server code | bucket policy governs server calls too | `signed=True` or `user=` |
| `bucket … asks for the s3 driver` | no S3 driver in 1.0.0 | custom `Driver` (see `sillo-storage`) |
| Inertia page 500: `Decimal is not JSON serializable` | props are serialised with plain `json.dumps` | convert Decimals before passing props |
| `ModuleNotFoundError: sillo.graphql` / `sillo.wire` | packages import as `sillo_graphql` / `sillo_wire` | fix the import |
