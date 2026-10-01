---
name: sillo-security
title: CORS, CSRF, security headers & crypto
description: >-
  Hardening a Sillo app: CORSMiddleware/CorsConfig, CSRFMiddleware for cookie-authenticated
  forms, Shield security headers and CSP, HTTPS redirects, trusted client IPs, and signing
  or encrypting values.
intents:
  - allow my React frontend on another domain to call the API
  - fix the CORS error
  - add CSRF protection to the forms
  - add security headers
  - force HTTPS
  - encrypt this field before storing it
  - sign a value for an email link
capabilities: [cors, csrf, security_headers, cryptography]
related: [sillo-middleware, sillo-auth, sillo-sessions, sillo-rate-limiting, sillo-helpers]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework", "sillo-framework[crypto] for encryption"]
symbols:
  - sillo.security.CORSMiddleware
  - sillo.security.CorsConfig
  - sillo.security.CSRFMiddleware
  - sillo.security.CSRFConfig
  - sillo.security.Shield
  - sillo.helpers.crypto.encrypt
  - sillo.helpers.crypto.decrypt
  - sillo.helpers.crypto.generate_key
  - sillo.helpers.signing.URLSafeTimedSerializer
  - sillo.helpers.network.get_client_ip
probes:
  - cors_allowed_origin_and_preflight
  - csrf_is_disabled_by_default_and_enforced_when_enabled
  - shield_sets_security_headers
  - shield_defaults_block_cdn_scripts_and_duplicate_cache_control
  - get_client_ip_trusts_forwarded_for_unconditionally
sources:
  - core:sillo/security/cors/config.py
  - core:sillo/security/csrf/config.py
  - core:sillo/security/shield.py
  - core:sillo/helpers/crypto.py
  - core:sillo/helpers/signing.py
  - core:sillo/application.py
  - docs:v1.0/guides/cors.md
  - docs:v1.0/guides/csrf.md
  - docs:v1.0/guides/security.md
status: stable
---

## When

Cross-origin browser access (CORS), protecting cookie-authenticated forms (CSRF),
response security headers and CSP, HTTPS enforcement, and signing or encrypting values.
Login is `sillo-auth`; throttling is `sillo-rate-limiting`.

## Inspect first

- Middleware order (CORS must be near the outside) — `sillo-middleware`.
- Whether authentication uses cookies (sessions) — then CSRF matters — or bearer tokens.
- The frontend's origin(s), and whether it sends credentials (cookies).
- Anything the pages load from other origins (CDNs, the Vite dev server, `/docs` UIs)
  before tightening a CSP.

## How

**CORS** — register late so it is outer:

```python
from sillo.security import CORSMiddleware, CorsConfig

app.use(CORSMiddleware(config=CorsConfig(
    allow_origins=settings.cors_origins,          # exact origins; not "*" with credentials
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-CSRFToken"],
    allow_credentials=True,                       # cookies / Authorization from the browser
    expose_headers=["X-Request-ID"],
    max_age=600,
)))
```

`allow_origin_regex=r"https://.*\.example\.com"` for subdomains. A disallowed origin
gets no `Access-Control-Allow-Origin` header.

**CSRF** — off unless enabled; needed when browsers authenticate with cookies:

```python
from sillo.security import CSRFConfig, CSRFMiddleware

app.use(CSRFMiddleware(config=CSRFConfig(
    enabled=True,
    secret_key=settings.secret_key,
    exempt_urls=["/api/webhooks/*"],     # machine callers with their own auth
)))
```

Any safe request sets the `csrftoken` cookie; the token is also `ctx.state.csrf_token`.
State-changing requests must echo it in the `X-CSRFToken` header or a `csrftoken` form
field, or they get 403. SPAs read the cookie (it is not HttpOnly by default) and send
the header; server-rendered forms include a hidden field.

**Security headers:**

```python
from sillo.security import Shield

app.use(Shield(
    csp_policy={
        "default-src": ["'self'"],
        "script-src": ["'self'", "https://cdn.jsdelivr.net"],   # /docs UIs load from CDNs
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:"],
    },
    cross_origin_embedder_policy="unsafe-none",   # default require-corp blocks cross-origin images
    cache_control="no-store",                     # sent on every response
    hsts_enabled=not settings.debug,
))
```

**HTTPS:** `SilloApp(force_https=True)` answers http with a 308 to https and honours
`X-Forwarded-Proto` from the proxy; HSTS comes from `Shield`.

**Signing and encryption** — [crypto.md](references/crypto.md): `URLSafeTimedSerializer`
for expiring links, `sign_value`/`unsign_value`, `encrypt`/`decrypt` (Fernet; needs
`sillo-framework[crypto]`), the `encrypted` model cast.

**Client IPs.** `ctx.get_client_ip()` trusts `X-Forwarded-For` from anyone; for
decisions use `sillo.helpers.network.get_client_ip(ctx.headers, peer, trusted_proxies=[...])`.

## Compose

- Order with sessions/auth/rate limits — `sillo-middleware` (ordering reference).
- Session cookies and their flags — `sillo-sessions`. Login throttling —
  `sillo-rate-limiting`.
- Password hashing — `sillo-users`; JWT secrets — `sillo-auth`.

## Verify

`TestClient` with `headers={"Origin": ...}` for CORS (allowed and disallowed origins,
and an `OPTIONS` preflight with `Access-Control-Request-Method`); a POST without and with
the CSRF header (403, then 2xx); the presence of each header you rely on. Load `/docs`
in a browser after enabling `Shield` — a blank page means the CSP blocks its script.

## Avoid

- `allow_origins=["*"]` with `allow_credentials=True`: browsers reject it.
- Registering CORS innermost: 401/403/429 responses lose their CORS headers and the
  browser reports a CORS error instead of the real status.
- Assuming CSRF is on: `CSRFConfig().enabled` is `False`.
- `Shield()` defaults in an app with `/docs`, Inertia/Vite or third-party assets: the
  default CSP allows only `'self'`, COEP `require-corp` blocks cross-origin images, and a
  `Cache-Control: no-store` header is added to **every** response (alongside any the
  handler set). Configure them.
- Treating a signed cookie/session as secret: signed is not encrypted.
