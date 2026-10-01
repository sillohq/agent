---
name: sillo-oauth
title: OAuth sign-in
description: >-
  "Sign in with Google, GitHub, Discord or Microsoft" using sillo-oauth: authorize_url and exchange,
  providers, the signed state cookie, OAuthProfile, OAuthError codes, and what to do with the profile.
intents:
  - add sign in with Google
  - log users in with GitHub
  - the OAuth callback fails with state_mismatch
  - link a Discord account to the signed-in user
  - support a provider sillo-oauth does not ship
capabilities: [oauth]
related: [sillo-auth, sillo-sessions, sillo-users, sillo-security]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-oauth>=1.0"]
symbols:
  - sillo_oauth.authorize_url
  - sillo_oauth.exchange
  - sillo_oauth.complete
  - sillo_oauth.refresh_tokens
  - sillo_oauth.OAuthProvider
  - sillo_oauth.GoogleOAuthProvider
  - sillo_oauth.GithubOAuthProvider
  - sillo_oauth.DiscordOAuthProvider
  - sillo_oauth.MicrosoftOAuthProvider
  - sillo_oauth.OAuthProfile
  - sillo_oauth.OAuthError
  - sillo_oauth.AuthorizeURL
probes: []
sources:
  - pkg:oauth/README.md
  - pkg:oauth/sillo_oauth/flow.py
  - pkg:oauth/sillo_oauth/models.py
  - pkg:oauth/sillo_oauth/providers.py
  - docs:v1.0/guides/oauth/index.md
status: stable
---

## When

Third-party sign-in (Google, GitHub, Discord, Microsoft, any OAuth 2.0 / OIDC provider), and
"the callback always fails". Passwords and tokens issued by the app itself are `sillo-auth`.

## Inspect first

- Whether `sillo-oauth` is installed and which providers the project already builds.
- Where the login is turned into a session or JWT (`sillo-auth`), and the user model that
  will hold the external identity (`sillo-users`).
- The registered redirect URI at the provider: it must equal `redirect_uri` exactly.

## How

There is no router, middleware or config object. Two functions and a provider; you write
the two routes.

```python
from sillo import HttpContext, redirect
from sillo.auth.session_auth import login
from sillo_oauth import GoogleOAuthProvider, OAuthError, authorize_url, exchange

google = GoogleOAuthProvider(
    client_id=settings.google_client_id,
    client_secret=settings.google_client_secret,
    state_secret=settings.secret_key,          # signs the state cookie; not the client secret
    redirect_uri="https://example.com/auth/google/callback",
)

@app.get("/auth/google/redirect", exclude_from_schema=True)
async def start(ctx: HttpContext):
    authorize = authorize_url(google, return_to=ctx.query_params.get("next"))
    return redirect(authorize.url).set_cookie(
        **authorize.cookie_kwargs(secure=settings.app_env != "local")
    )

@app.get("/auth/google/callback", exclude_from_schema=True)
async def finish(ctx: HttpContext):
    try:
        profile = await exchange(google, ctx)
    except OAuthError as exc:
        return redirect(f"/login?error={exc.code}")
    user = await User.objects.get_or_create_from_oauth("google", profile)   # your code
    login(ctx, user)
    return redirect(profile.return_to or "/")
```

`authorize_url` is pure (no request, no I/O) and returns the URL plus the state to store.
`exchange` reads the callback and returns a verified `OAuthProfile`; it never touches the
response. What a login *means* (session, JWT, linking, nothing) is your handler's decision.

**Profile**: `provider`, `subject`, `key` (`"google:112233"`), `email`, `email_verified`,
`name`, `username`, `avatar_url`, `raw`, `tokens`, `return_to`.

**Errors**: one `except OAuthError` is enough; `.code` is URL-safe: `denied` (not a fault),
`provider_error`, `state_mismatch`, `state_expired`, `exchange_failed`, `profile_failed`,
`provider_misconfigured` (a programming error).

**Other providers**: `OAuthProvider(name=, client_id=, client_secret=, state_secret=,
authorize_endpoint=, token_endpoint=, userinfo_endpoint=, scopes=[...])`, with
`profile_mapper=` or an overridden `map_profile` for odd payloads. Self-hosted installs
override the endpoints on the shipped providers.

**State elsewhere** (session instead of cookie): store `authorize.cookie_value`, then
`exchange(google, ctx, state_value=stored)`. Without a request (worker, CLI, test) use
`complete`, `exchange_code`, `fetch_profile`, `refresh_tokens`.

## Compose

Session or JWT login after `exchange` — `sillo-auth` (and `sillo-sessions`, registered in the
right order); persisting `profile.subject` against a user — `sillo-users` / `sillo-record`.

## Verify

Unit-test the handlers by passing a stubbed provider transport; the package's own suite
never touches the network. Manually: hit the redirect route, confirm the state cookie is set,
complete consent, confirm the callback lands on the post-login page.

## Avoid

- Keying accounts on `profile.email`: use `subject`. Unverified addresses are an account
  takeover vector (`email_verified` is `False` when the provider said nothing).
- Local development over `http://` without `cookie_kwargs(secure=False)`: the browser drops
  the `Secure` cookie and every callback fails as `state_mismatch`.
- Setting the cookie on one response and returning another: the cookie is lost.
- Redirecting to `profile.return_to` unchecked: it is signed but caller-chosen; validate it.
- Passing `state`, `code_challenge` or `client_id` in `extra_params`: refused by design.
- The README-style `(request, response)` handlers: that is the 0.x API.
