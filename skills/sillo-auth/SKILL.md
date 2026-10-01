---
name: sillo-auth
title: Authentication
description: >-
  Adding login to Sillo: AuthenticationMiddleware with session, JWT or API-key backends,
  register/login/logout endpoints, issuing tokens, protecting routes with useAuth, and
  reading ctx.user.
intents:
  - add Sillo auth to my project
  - add login and registration
  - protect the dashboard route
  - get the authenticated user
  - add JWT authentication to the API
  - add API key authentication for integrations
  - log the user out
  - only logged-in users can see this
capabilities: [authentication, route_protection]
related: [sillo-users, sillo-sessions, sillo-authorization, sillo-rate-limiting, sillo-security, sillo-oauth]
requires: [sillo, sillo-record]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework[record,jwt]"]
symbols:
  - sillo.auth.AuthenticationMiddleware
  - sillo.auth.useAuth
  - sillo.auth.SessionAuthBackend
  - sillo.auth.JWTAuthBackend
  - sillo.auth.APIKeyAuthBackend
  - sillo.auth.session_auth.login
  - sillo.auth.session_auth.logout
  - sillo.auth.session_auth.SessionGuard
  - sillo.auth.jwt_auth.TokenForUser
  - sillo.auth.apikey.ApiKeyUserMixin
  - sillo.auth.exceptions.AuthenticationFailed
  - sillo.auth.exceptions.PermissionDenied
  - sillo.users.UserBaseModel.verify_credentials
  - sillo.helpers.jwt.TokenError
probes:
  - session_login_flow_with_auth_registered_before_session
  - session_before_auth_registration_breaks_login
  - jwt_backend_needs_identifier_sub
  - useauth_signature_and_router_has_no_auth_argument
  - useauth_unauthorized_hook_replaces_401
  - setup_record_must_come_after_auth_middleware
  - app_delete_and_options_ignore_auth_in_1_0_0
  - api_key_issue_and_authenticate
  - stateless_refresh_recipe_rejects_access_tokens
  - ctx_user_without_auth_middleware_raises
sources:
  - core:sillo/auth/middleware.py
  - core:sillo/auth/use_auth.py
  - core:sillo/auth/session_auth/backend.py
  - core:sillo/auth/jwt_auth/backend.py
  - core:sillo/auth/jwt_auth/tokens.py
  - core:sillo/auth/apikey/backend.py
  - core:sillo/application.py
  - docs:v1.0/guides/authentication.md
  - docs:v1.0/guides/protecting-routes.md
  - pkg:starter/app/bootstrap.py
  - pkg:starter/routes/auth.py
status: stable
---

## When

Anything about *who the caller is*: sign-up, login, logout, tokens, API keys,
protecting routes, reading `ctx.user`. What a known user may do (roles, permissions,
ownership) is `sillo-authorization`; the user model and passwords are `sillo-users`;
"sign in with Google" is `sillo-oauth`.

## Inspect first

- The user model (`database/models/user.py` in the sillo-start layout) — it must be a
  Record model built on `UserBaseModel` (see `sillo-users`).
- Every `app.use(...)` and its order, and `setup_record` / `Record` placement.
- Whether the app is a browser app (sessions + cookies), an API for SPAs/mobile (JWT),
  machine-to-machine (API keys) — or several. Existing `routes/auth.py`.

## How

Two layers: **`AuthenticationMiddleware`** resolves `ctx.user` on every request (it never
rejects), and **`useAuth`** on a route rejects callers that do not qualify (401/403).

**1. Wire it — order matters** (last `use` is outermost; see `sillo-middleware`):

```python
from sillo.auth import AuthenticationMiddleware
from sillo.auth.session_auth import SessionAuthBackend
from sillo.record import setup_record
from sillo.session import SessionConfig, SessionMiddleware

app.use(AuthenticationMiddleware(user_model=User, backend=SessionAuthBackend()))   # 1st
app.use(SessionMiddleware(
    config=SessionConfig(session_cookie_secure=not settings.debug),   # http in dev
    secret_key=settings.secret_key,
))                                                                                  # 2nd
setup_record(app, database_config(), model_modules=["database.models"])             # last
```

For bearer tokens use `JWTAuthBackend(secret_key=settings.jwt_secret, identifier="sub")`
(`identifier="sub"` is required with Sillo-issued tokens). For keys,
`APIKeyAuthBackend(header_name="X-API-Key", verify_with_manager=True)`. Pass a list to
accept several; the first that succeeds wins.

**2. Endpoints** — the pattern sillohq/starter ships:

```python
from pydantic import BaseModel, EmailStr, Field
from sillo import HttpContext, Router, created, json
from sillo.auth import useAuth
from sillo.auth.session_auth import login as start_session, logout as end_session

router = Router(prefix="/api/auth", tags=["auth"])

class RegisterIn(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=150)
    password: str = Field(min_length=8, max_length=128)

class LoginIn(BaseModel):
    identifier: str          # email or username
    password: str

@router.post("/register", request_model=RegisterIn)
async def register(ctx: HttpContext, payload):
    if await User.objects.get_by_email(payload.email):
        return json({"detail": "That email is already registered."}, status_code=409)
    user = await User.objects.create_user(email=payload.email, username=payload.username,
                                          password=payload.password)
    return created({"id": user.id, "email": user.email})

@router.post("/login", request_model=LoginIn)
async def login(ctx: HttpContext, payload):
    user = await User.verify_credentials(payload.identifier, payload.password)
    if user is None:
        return json({"detail": "Invalid credentials."}, status_code=401)
    start_session(ctx, user)        # JWT instead: return TokenForUser(user, secret=...).token_pair()
    return {"id": user.id}

@router.post("/logout")
async def logout(ctx: HttpContext):
    end_session(ctx)
    return {"ok": True}

@router.get("/me", auth=useAuth())
async def me(ctx: HttpContext):
    return {"id": ctx.user.id, "email": ctx.user.email}
```

`User.verify_credentials` looks the user up by email *or* username, rejects inactive
accounts, checks the hash and stamps `last_login`.

**3. Protect routes** with `auth=useAuth(...)` on the route:

```python
@router.get("/dashboard", auth=useAuth())                                  # any signed-in user
@router.get("/api/orders", auth=useAuth(schemes=["bearerAuth"]))           # JWT callers only
@router.get("/feed", auth=useAuth(required=False))                         # anonymous allowed
@router.get("/account", auth=useAuth(unauthorized=lambda ctx: redirect("/login")))
```

Scheme names: `bearerAuth` (JWT), `sessionCookie`, `apiKeyHeader`. Anonymous callers get
401 (`AuthenticationFailed`), missing permissions 403 (`PermissionDenied`, see
`sillo-authorization`). `SilloApp(auth=[backends], auth_user_model=User)` is an
alternative that also documents the schemes in OpenAPI.

JWT issuing, refresh and revocation: [jwt.md](references/jwt.md). API keys:
[api-keys.md](references/api-keys.md). Custom backends and gates:
[custom.md](references/custom.md).

## Compose

- User model, passwords, `sillo user:create` — `sillo-users`.
- Roles/permissions and "only admins" — `sillo-authorization`.
- Session store details — `sillo-sessions`. CSRF for cookie auth — `sillo-security`.
- Throttle `/login` — `sillo-rate-limiting`. Welcome email on signup — `sillo-queues` +
  `sillo-mail`. Social login — `sillo-oauth`.

## Verify

Per protected route, three `TestClient` checks: anonymous → 401, wrong user/permission →
403 (or 404 for owned resources), right user → 200. Drive login through the real
endpoint (use `TestClient(app)` as a context manager so the database connects and the
session cookie is kept). **Include every DELETE route** in the anonymous check.

## Avoid

- **`@app.delete(..., auth=...)`, `@app.options(..., auth=...)` and
  `app.add_route(path=..., auth=...)` do not enforce `auth` in sillo-framework 1.0.0** —
  the route is public. Register protected DELETE/OPTIONS routes on a `Router`
  (`@router.delete(..., auth=useAuth())`) or as `Route(..., auth=useAuth())`, and test
  that an anonymous DELETE gets 401.
- `SessionMiddleware` registered before `AuthenticationMiddleware`: every request is
  anonymous. Auth first, session second, `setup_record` last.
- `JWTAuthBackend` without `identifier="sub"`: tokens verify but no user ever loads.
- `session_cookie_secure=True` (the default) on plain-http localhost: the cookie is
  never sent back, so login "works" and the next request is anonymous.
- Reading `ctx.user` without the middleware (it raises), or re-checking
  `ctx.user.is_authenticated` in every handler instead of `useAuth`.
- `Router(prefix=..., auth=...)`, `useAuth(scopes=...)`, `@auth` / `@has_permission`
  decorators: none exist in 1.x.
- Different error messages for "no such user" and "wrong password".
