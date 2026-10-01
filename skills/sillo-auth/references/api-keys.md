# API keys

For machine-to-machine access: long-lived, per-integration, hashed at rest, revocable.

## Model

```python
from sillo.auth.apikey.mixins import ApiKeyUserMixin
from sillo.record.fields import PasswordField
from sillo.users import UserBaseModel, UserManager


class User(UserBaseModel, ApiKeyUserMixin):
    objects = UserManager()
    password = PasswordField()

    class Meta:
        table = "users"


User.objects.contribute_to_class(User, "objects")
```

Register the key table with the ORM: add `ApiKey` (from `sillo.auth.apikey.models`) to
`database/models/__init__.py` / `__models__`, then make a migration.

## Wiring

```python
from sillo.auth import AuthenticationMiddleware
from sillo.auth.apikey import APIKeyAuthBackend

app.use(AuthenticationMiddleware(
    user_model=User,
    backend=[
        APIKeyAuthBackend(header_name="X-API-Key", verify_with_manager=True),
        JWTAuthBackend(secret_key=settings.jwt_secret, identifier="sub"),
    ],
))
```

`verify_with_manager=True` checks presented keys against stored hashes (and expiry /
revocation). Scheme name: `apiKeyHeader`.

## Issuing and revoking

```python
full_key, row = await user.create_api_key(name="ci", scopes=["read:orders"], expires_at=None)
# full_key is shown to the user once; only its hash is stored.

await user.get_api_keys()          # active key rows
await user.revoke_api_key(row.id)
await user.revoke_all_api_keys()
```

## Restricting a route to key callers

```python
@router.post("/webhooks/inventory", auth=useAuth(schemes=["apiKeyHeader"]))
async def inventory_webhook(ctx: HttpContext):
    ...
```

A per-key scope check reads the key row: `await ApiKeyManager().verify(raw)` returns the
`ApiKey` (with `.scopes`) or `None`.
