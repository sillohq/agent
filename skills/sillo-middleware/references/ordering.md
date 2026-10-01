# Middleware ordering

`app.use(x)` inserts `x` at the front of the chain; the chain is built so the **most
recently registered middleware is the outermost**. Everything else follows from that.

## A full stack, registered correctly

```python
# innermost first ─────────────────────────────────────────────
app.use(AuthenticationMiddleware(user_model=User, backend=[SessionAuthBackend(),
                                                           JWTAuthBackend(secret_key=s.jwt_secret, identifier="sub")]))
app.use(CSRFMiddleware(config=CSRFConfig(enabled=True, secret_key=s.secret_key)))
app.use(RateLimitMiddleware(config=RateLimitConfig(limit=100, window=60)))
app.use(SessionMiddleware(config=SessionConfig(session_cookie_secure=not s.debug),
                          secret_key=s.secret_key))
app.use(RequestId())
app.use(CORSMiddleware(config=CorsConfig(allow_origins=s.cors_origins, allow_credentials=True)))
# outermost last ──────────────────────────────────────────────
setup_record(app, database_config(), model_modules=MODEL_MODULES)   # adds its own, outermost
```

Request path: record context → CORS → request id → session → rate limit → CSRF → auth
→ route middleware → handler.

Why each position:

- **Auth inside the session**: `SessionAuthBackend` reads `ctx.session`.
- **The database context outermost**: auth backends load the user from the database.
  `setup_record` registers `ensure_context` through `app.use`, so call it **after** the
  other `app.use` lines (or install `Record` last).
- **CORS outermost** (below the DB context): a 401/403/429 still needs CORS headers or
  the browser reports a CORS error instead of the real status.
- **Rate limiting before auth work**: cheap rejection first.

## Things that register middleware for you

| Call | Registers |
|---|---|
| `setup_record(...)` / `app.install(Record(...))` | per-request DB context (`ensure_context`) |
| `SilloApp(auth=[...], auth_user_model=User)` | `AuthenticationMiddleware` at construction — i.e. innermost, before anything you `use` later |
| warder `Admin(...).mount(app)` | its own auth middleware (needs the session outside it) |

## Scopes

| Where | Order |
|---|---|
| app | last `use` outermost |
| router | `router.use(x)` wraps the `Router(middleware=[a, b])` list; `a` is outside `b` |
| route | `middleware=[a, b]`: `a` outside `b`, all inside app and router middleware |

## Diagnosing

```python
seen = []

def mark(name):
    async def mw(ctx, call_next):
        seen.append(name)
        return await call_next()
    return mw
```

Register `mark("…")` between existing layers, make one request with `TestClient`, and
read `seen`.
