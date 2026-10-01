---
name: sillo-sessions
title: Sessions
description: >-
  Sillo's session store: SessionMiddleware and SessionConfig, reading and writing
  ctx.session, signed-cookie vs file or custom server-side storage, cookie flags, expiry,
  and clearing a session.
intents:
  - store the cart in the session
  - keep the user logged in across requests
  - the session is not persisting between requests
  - store sessions on the server instead of in the cookie
  - expire sessions after an hour
capabilities: [sessions]
related: [sillo-auth, sillo-security, sillo-middleware]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.session.SessionMiddleware
  - sillo.session.SessionConfig
  - sillo.session.file.FileSessionManager
  - sillo.session.base.BaseSessionInterface
  - sillo.core.http.context.HttpContext.session
probes:
  - session_persists_only_when_cookie_secure_is_off_over_http
  - session_middleware_rejects_unknown_settings
  - session_before_auth_registration_breaks_login
sources:
  - core:sillo/session/middleware.py
  - core:sillo/session/config.py
  - core:sillo/session/signed_cookies.py
  - core:sillo/session/file.py
  - docs:v1.0/guides/sessions.md
status: stable
---

## When

Per-visitor state across requests (carts, wizards, flash data, the logged-in user for
cookie auth), and "why does my session reset every request".

## Inspect first

- `SessionMiddleware` registration and its position relative to
  `AuthenticationMiddleware` (auth must be registered before it).
- `SessionConfig` values, especially `session_cookie_secure` for local http.
- Whether sessions must be revocable server-side (then not the default signed cookie).

## How

```python
from sillo.session import SessionConfig, SessionMiddleware

app.use(SessionMiddleware(
    config=SessionConfig(
        session_cookie_name="session_id",
        session_expiration_time=60 * 60 * 24,        # seconds
        session_cookie_secure=settings.app_env != "local",
        session_cookie_samesite="lax",
    ),
    secret_key=settings.secret_key,                  # signs the cookie
))
```

Settings can also be passed as keywords (`SessionMiddleware(secret_key=..., session_cookie_secure=False)`);
unknown names raise `TypeError` naming the right one.

```python
from sillo import HttpContext

@app.post("/cart/{product_id:int}")
async def add_to_cart(ctx: HttpContext, product_id: int):
    cart = ctx.session.get("cart", {})
    cart[str(product_id)] = cart.get(str(product_id), 0) + 1
    ctx.session["cart"] = cart            # reassign so the change is saved
    return {"items": sum(cart.values())}
```

`ctx.session` is a mapping: `get`, `[]`, `del`, `in`, `keys()`, `clear()`,
`set_expiry(seconds)`. Values must be JSON-serialisable.

**Storage.** The default `SignedSessionManager` keeps everything in the (signed, not
encrypted) cookie: no storage needed, ~4 KB max, cannot be revoked before expiry.
`FileSessionManager(config)` with `SessionConfig(session_file_storage_path="sessions")`
stores server-side; for Redis or a database subclass
`sillo.session.base.BaseSessionInterface` (`load`, `save`, session key handling) and pass
it as `manager=`. Server-side stores must be shared by all worker processes.

**Logout** is `ctx.session.clear()` (or `sillo.auth.session_auth.logout(ctx)`), which
also purges a server-side record.

## Compose

- Session-based login — `sillo-auth` (`SessionAuthBackend`, `login`/`logout`).
- Cookie sessions need CSRF protection for state-changing requests — `sillo-security`.
- Ordering with other middleware — `sillo-middleware`.

## Verify

A `TestClient` test that makes two requests in a row and sees the value from the first
(the client keeps cookies). If it resets, check `session_cookie_secure` first.

## Avoid

- `session_cookie_secure=True` (the default) on `http://localhost`: the browser (and
  `TestClient` against `http://testserver`) never sends the cookie back, so the session
  resets on every request.
- Mutating a nested value in place without reassigning the key.
- `ctx.session.clear()` then writing new keys in the same request — the cleared session
  is saved empty. Clear on logout only.
- Secrets or permissions in a cookie session: signed is readable by the client.
- In-memory or per-process file stores behind several workers without shared storage.
