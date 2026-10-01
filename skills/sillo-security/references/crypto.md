# Signing and encryption helpers

## Expiring signed tokens (password reset, email verification links)

```python
from sillo.helpers.signing import BadSignature, SignatureExpired, URLSafeTimedSerializer

signer = URLSafeTimedSerializer(settings.secret_key, salt="password-reset")
token = signer.dumps({"user_id": user.id})           # URL-safe string

try:
    data = signer.loads(token, max_age=3600)          # seconds
except SignatureExpired:
    ...                                               # too old
except BadSignature:
    ...                                               # tampered or wrong salt
```

Use a distinct `salt` per purpose so a token for one flow is useless in another.

## Signing a single value

```python
from sillo.helpers.crypto import sign_value, unsign_value

signed = sign_value("42", settings.secret_key)
value = unsign_value(signed, settings.secret_key)     # raises BadSignature when tampered
```

`sign_value` writes no timestamp, so `unsign_value(..., max_age=...)` raises
`NotImplementedError`; anything that must expire uses `URLSafeTimedSerializer`.

## Encrypting values (needs `sillo-framework[crypto]`)

```python
from sillo.helpers.crypto import decrypt, encrypt, generate_key

key = generate_key()                          # store in the environment, not the repo
token = encrypt("sk_live_…", key)
plain = decrypt(token, key)
```

For a model column, prefer the cast so encryption happens on save and decryption on
load:

```python
class Integration(Model):
    api_token = fields.TextField(null=True)
    _casts = {"api_token": ("encrypted", {"key": settings.field_key})}
```

## Hashing

Passwords: `sillo.hashing.hash_password` / `verify_password` (see `sillo-users`).
General digests and HMAC: `sillo.helpers.hashing.digest`, `hmac_digest`,
`constant_time_compare` — use `constant_time_compare` for any secret comparison
(webhook signatures, tokens).

## Webhook signature check

```python
import hmac, hashlib
from sillo import HttpContext, abort
from sillo.helpers.hashing import constant_time_compare

@router.post("/webhooks/payments")
async def payments_webhook(ctx: HttpContext):
    body = await ctx.body
    expected = hmac.new(settings.webhook_secret.encode(), body, hashlib.sha256).hexdigest()
    if not constant_time_compare(expected, ctx.headers.get("x-signature", "")):
        abort(401, detail="bad signature")
    ...
```
