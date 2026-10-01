# Users that are not database rows

`AuthenticationMiddleware(user_model=…)` accepts anything satisfying
`sillo.users.UserProtocol`:

```python
from sillo.users import UserProtocol


class DirectoryUser(UserProtocol):
    def __init__(self, dn: str, name: str, groups: list[str]):
        self.dn, self.name, self.groups = dn, name, groups

    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def identity(self) -> str:
        return self.dn

    @property
    def display_name(self) -> str:
        return self.name

    def has_permission(self, perm: str) -> bool:
        return perm in self.groups

    @classmethod
    async def load_user(cls, identity: str):
        entry = await directory.find(identity)
        return cls(entry.dn, entry.name, entry.groups) if entry else None
```

`load_user` receives the identity string the backend produced (the JWT `sub`, the
session's stored id, the API key's user id) and returns a user or `None`.

## Test users

```python
from sillo.users import AnonymousUser, SimpleUser

SimpleUser("alice", permissions=["orders:read"]).has_permission("orders:read")   # True
AnonymousUser().is_authenticated                                                  # False
```

`SimpleUser` works as `user_model` in tests of gates and permissions without a database.

## Combining the mixins

```python
from sillo.auth.apikey.mixins import ApiKeyUserMixin
from sillo.auth.jwt_auth.mixins import JWTUserMixin
from sillo.auth.session_auth.mixins import SessionUserMixin
from sillo.permissions import PermissionMixin


class User(PermissionMixin, UserBaseModel, JWTUserMixin, SessionUserMixin, ApiKeyUserMixin):
    ...
```

`PermissionMixin` goes first so its `has_permission` wins. Each mixin needs its own
tables registered (`sillo.permissions.models`, `sillo.auth.apikey.models`, the session
and JWT models) — add the model classes to your models package and migrate.
