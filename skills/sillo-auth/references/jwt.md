# JWT authentication

## Verifying tokens

```python
from sillo.auth import AuthenticationMiddleware
from sillo.auth.jwt_auth import JWTAuthBackend

app.use(AuthenticationMiddleware(
    user_model=User,
    backend=JWTAuthBackend(secret_key=settings.jwt_secret, identifier="sub"),
))
```

- Reads `Authorization: Bearer <token>`, verifies HS256 with `secret_key`, loads the
  user with `User.load_user(payload["sub"])`, sets `ctx.scope["auth"] = "jwt"` and scheme
  `bearerAuth`.
- `identifier="sub"` is required: the default `"id"` does not match what
  `TokenForUser` writes, and every request silently stays anonymous.
- `check_blacklist=True` (default) rejects tokens listed in `TokenBlacklist` — that table
  must be registered (it lives in `sillo.auth.jwt_auth`) if you use blacklisting.

## Issuing tokens

```python
from datetime import timedelta
from sillo.auth.jwt_auth import TokenForUser

tokens = TokenForUser(user, secret=settings.jwt_secret)
pair = tokens.token_pair()      # {"access_token", "refresh_token", "token_type": "bearer"}
access = tokens.access_token(expires_in=timedelta(minutes=15))
refresh = tokens.refresh_token(expires_in=timedelta(days=7))
```

Claims: `sub` (the user identity as a string), `iat`, `exp`, `typ` (`"access"` or
`"refresh"`). `issuer=`/`audience=`/`algorithm=` are accepted by `TokenForUser`.

## Refresh (stateless)

Access and refresh tokens differ only by `typ`, so check it — otherwise an access token
can be presented as a refresh token:

```python
from sillo import HttpContext, json
from sillo.auth.jwt_auth import TokenForUser
from sillo.helpers.jwt import TokenError      # expired, malformed, bad signature

@router.post("/refresh")
async def refresh(ctx: HttpContext):
    raw = (await ctx.json).get("refresh_token", "")
    try:
        claims = TokenForUser.decode_unverified(raw)
        user = await User.load_user(str(claims.get("sub", "")))
        if user is None or claims.get("typ") != "refresh":
            raise ValueError("not a refresh token")
        TokenForUser(user, secret=settings.jwt_secret).verify(raw)   # signature + expiry
    except (TokenError, ValueError):
        return json({"detail": "Invalid refresh token."}, status_code=401)
    return TokenForUser(user, secret=settings.jwt_secret).token_pair()
```

Verify before trusting anything from the token in real code paths; `decode_unverified`
is only used here to find which user to verify against.

## Database-backed tokens (`JWTUserMixin`)

`JWTUserMixin` adds `issue_token_pair`, `refresh_token_pair`, `revoke_all_tokens`,
`blacklist_token`, `active_token_count`, persisting tokens in `JWTToken` rows. In
sillo-framework 1.0.0, `refresh_token_pair` looks tokens up by a `jti` claim that
`TokenForUser` does not emit, so rotation through it fails with
"Unknown refresh token"; use the stateless refresh above (plus `blacklist_token` for
immediate revocation) until that is fixed. Check the installed
`sillo/auth/jwt_auth/mixins.py` before relying on it.

## Low-level helpers

`from sillo.auth import create_jwt, decode_jwt`:
`create_jwt(payload, secret, expires_in=timedelta(hours=1))` and
`decode_jwt(token, secret)`, which raises `ValueError` for bad or expired tokens. The
secret is positional. `TokenForUser.decode_unverified` / `.verify` raise
`sillo.helpers.jwt.TokenError` subclasses instead — catch both, as the refresh example
does.

## Operational notes

- Keep access tokens short-lived (minutes). Put the secret in the environment.
- Never put a token in a URL; it ends up in logs.
- Test the failure modes: expired, wrong signature, malformed, access-as-refresh.
