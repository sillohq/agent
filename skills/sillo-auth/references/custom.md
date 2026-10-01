# Custom backends and gates

## A backend

A backend turns a credential into an identity string; the middleware then calls
`user_model.load_user(identity)`:

```python
from sillo import HttpContext
from sillo.auth.backend import AuthenticationBackend
from sillo.auth.model import AuthResult


class ServiceTokenBackend(AuthenticationBackend):
    name = "serviceToken"              # what useAuth(schemes=[...]) matches

    async def authenticate(self, ctx: HttpContext) -> AuthResult:
        token = ctx.headers.get("x-service-token")
        if not token:
            return AuthResult(success=False, identity="", scope="")   # let the next backend try
        service_id = await lookup_service(token)
        if service_id is None:
            return AuthResult(success=False, identity="", scope="")
        return AuthResult(success=True, identity=str(service_id), scope="service")
```

Give it a `describe()` returning an OpenAPI security scheme to have it documented.

## A user model without a database

Anything satisfying `sillo.users.UserProtocol` works as `user_model`:
`is_authenticated`, `identity`, `display_name`, `has_permission(perm)` and an async
classmethod `load_user(identity)`. `sillo.users.SimpleUser` is a ready-made one for tests.

## A stricter gate

Subclass `useAuth` and extend `authenticate(ctx)`; call the parent first:

```python
from sillo.auth import useAuth
from sillo.auth.exceptions import PermissionDenied


class OrgMember(useAuth):
    async def authenticate(self, ctx) -> bool:
        if not await super().authenticate(ctx):
            return False
        if ctx.path_params.get("org_id") not in {str(o) for o in await ctx.user.org_ids()}:
            raise PermissionDenied()
        return True


@router.get("/orgs/{org_id}/members", auth=OrgMember())
async def members(ctx: HttpContext, org_id: str):
    ...
```

## Per-route failure responses

```python
@router.get("/dashboard", auth=useAuth(unauthorized=lambda ctx: redirect("/login")))
@router.get("/api/admin", auth=useAuth(permissions=["admin"],
                                       forbidden=lambda ctx: json({"error": "forbidden"}, status_code=403)))
```

Globally: `app.add_exception_handler(AuthenticationFailed, handler)` and
`PermissionDenied` from `sillo.auth.exceptions`.
