---
name: sillo-rate-limiting
title: Rate limiting
description: >-
  Throttling Sillo requests with RateLimit / RateLimitMiddleware: app-wide or per-router
  limits, per-route limits via check(), strategies, memory/Redis/record backends, keys, 429
  responses and headers.
intents:
  - only allow 5 login attempts per minute
  - rate limit the API per client
  - throttle this endpoint
  - return 429 when clients send too many requests
  - rate limit by API key instead of IP
capabilities: [rate_limiting]
related: [sillo-auth, sillo-middleware, sillo-cache, sillo-security]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework", "sillo-framework[cache] for the redis backend"]
symbols:
  - sillo.security.RateLimit
  - sillo.security.RateLimitMiddleware
  - sillo.security.RateLimitConfig
  - sillo.security.RateLimitMiddleware.check
  - sillo.security.RateLimitResult
  - sillo.security.RedisBackend
probes:
  - rate_limit_scoping_what_works_and_what_500s
  - app_wide_rate_limit_headers
  - rate_limit_default_key_follows_x_forwarded_for
sources:
  - core:sillo/security/ratelimit/__init__.py
  - core:sillo/security/ratelimit/_middleware.py
  - core:sillo/security/ratelimit/config.py
  - docs:v1.0/guides/rate-limiting.md
status: stable
---

## When

Limiting how often a client may call the app, a group of routes, or one sensitive route
(login, password reset, signup, expensive reports) — and returning 429s properly.

## Inspect first

- Existing `RateLimit(...)` registrations and their position (`sillo-middleware`).
- How many processes serve the app: in-memory counters are per process.
- What identifies a client here: IP behind which proxy, API key, user id.

## How

`RateLimit(limit, window, strategy="token"|"fixed"|"sliding", backend="memory"|"redis"|"record", key_func=, namespace=, cost=, on_exceed=, fail_open=True)`
is **raw ASGI middleware**. Where it can go:

| Scope | Works |
|---|---|
| whole app | `app.use(RateLimit(limit=100, window=60))` |
| one router | `router.use(RateLimit(...))` |
| one route | a dispatch wrapper around `.check(ctx)` (below) |
| `@app.post(..., middleware=[RateLimit(...)])` or `Router(middleware=[RateLimit(...)])` | **no — 500** |

**Five login attempts per minute per client:**

```python
from sillo import HttpContext, json
from sillo.helpers.network import get_client_ip
from sillo.security import RateLimit

def client_key(ctx: HttpContext) -> str:
    peer = ctx.client.host if ctx.client else ""
    return get_client_ip(ctx.headers, peer, trusted_proxies=settings.trusted_proxies)

login_limiter = RateLimit(limit=5, window=60, strategy="fixed", namespace="login",
                          key_func=client_key, backend=settings.rate_limit_backend)

async def limit_login(ctx: HttpContext, call_next):
    result = await login_limiter.check(ctx)
    if result is not None and not result.allowed:
        return json({"error": "too_many_attempts"}, status_code=429).set_header(
            "Retry-After", str(max(1, int(result.retry_after))), override=True)
    return await call_next()

@router.post("/login", middleware=[limit_login], request_model=LoginIn)
async def login(ctx: HttpContext, payload): ...
```

Or put the auth routes on their own router and `auth_router.use(RateLimit(...))`.

**App-wide** limits add `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers and deny
with 429 + `Retry-After`. `on_exceed=lambda ctx, result: json(...)` customises the
response; `cost=` charges several tokens per request.

**Backends.** `memory` is per process — fine for one worker and tests. With several
workers or instances use `backend="redis"` (install `sillo-framework[cache]`; pass a
`RedisBackend(url=...)` instance for a non-default URL) or `backend="record"` (database,
register `sillo.security.ratelimit.models`). `fail_open=True` (default) allows requests
when the backend is down.

## Compose

- Protecting `/login`, `/register`, password reset — `sillo-auth`.
- Order relative to CORS/auth — `sillo-middleware` (rate limit early, CORS outside it).
- Trusted proxy handling for client IPs — `sillo-security`.

## Verify

`TestClient`: N allowed requests then 429 with a numeric `Retry-After`; another route
unaffected when the limit is scoped; a different key (header/user) gets its own bucket.
Use a fixed `key_func` in tests.

## Avoid

- Passing `RateLimit(...)` in a route's `middleware=[...]` or `Router(middleware=[...])`:
  every request 500s. Use `router.use(...)` or the `check()` wrapper.
- The default key: it follows `X-Forwarded-For` from any client, so an attacker rotates
  the header and is never limited. Supply `key_func` using trusted proxies, or key by
  account/API key.
- `backend="memory"` with several workers: each has its own counters, so the effective
  limit multiplies.
- Rate limiting inside handlers by hand with the cache — the middleware already handles
  windows, headers and strategies.
