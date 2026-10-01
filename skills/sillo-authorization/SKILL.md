---
name: sillo-authorization
title: Authorization, roles & permissions
description: >-
  Deciding what an authenticated Sillo user may do: useAuth(permissions=...), PermissionMixin,
  Permission and Group models, superusers, and object-level ownership checks in queries.
intents:
  - only authenticated admins can access these routes
  - add roles and permissions
  - only the owner can edit this order
  - give editors permission to publish posts
  - return 403 when the user lacks permission
capabilities: [authorization, route_protection]
related: [sillo-auth, sillo-users, sillo-record, sillo-errors]
requires: [sillo-auth]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework[record]"]
symbols:
  - sillo.auth.useAuth
  - sillo.permissions.PermissionMixin
  - sillo.permissions.Permission
  - sillo.permissions.Group
  - sillo.permissions.Permission.define
  - sillo.permissions.Permission.assign
  - sillo.permissions.Permission.revoke
  - sillo.permissions.Group.get_or_create
  - sillo.permissions.Group.add_permissions
  - sillo.permissions.Group.add_user
  - sillo.permissions.PermissionMixin.load_permissions
  - sillo.auth.exceptions.PermissionDenied
probes:
  - permissions_gate_with_groups
  - app_delete_and_options_ignore_auth_in_1_0_0
sources:
  - core:sillo/permissions/mixins.py
  - core:sillo/permissions/models.py
  - core:sillo/auth/use_auth.py
  - docs:v1.0/guides/permissions.md
  - docs:v1.0/guides/protecting-routes.md
status: stable
---

## When

A signed-in user may or may not do something: admin-only routes, role/permission
checks, groups of permissions, or "users can only touch their own records".

## Inspect first

- The user model's bases: permissions need `PermissionMixin` first in the bases.
- Whether `sillo.permissions.models` tables are registered and migrated.
- Existing gates (`useAuth(permissions=[...])`) and how "admin" is modelled today
  (`is_staff`, `is_superuser`, a group, a permission string).

## How

**Model.**

```python
from sillo.permissions import PermissionMixin
from sillo.users import UserBaseModel, UserManager

class User(PermissionMixin, UserBaseModel):      # mixin FIRST
    objects = UserManager()
    ...
```

Register the permission tables — add `Permission`, `Group`, `UserPermission`,
`UserGroup`, `GroupPermission` from `sillo.permissions.models` to your models package
(`__models__`) — and run `sillo db:make` / `db:migrate`.

**Define and grant** (idempotent; a startup hook or a seed command is fine):

```python
from sillo.permissions import Group, Permission

await Permission.define("posts:publish")
editors = await Group.get_or_create("editors")
await editors.add_permissions("posts:publish", "posts:edit")
await editors.add_user(user)
await Permission.assign(user, "reports:export")      # direct grant
await Permission.revoke(user, "reports:export")
```

**Gate routes** — every listed permission must pass `user.has_permission(...)`:

```python
from sillo import HttpContext, Router
from sillo.auth import useAuth

admin = Router(prefix="/admin")

@admin.get("/reports", auth=useAuth(permissions=["reports:view"]))
async def reports(ctx: HttpContext): ...

@admin.delete("/posts/{post_id:int}", auth=useAuth(permissions=["posts:delete"]))
async def delete_post(ctx: HttpContext, post_id: int): ...
```

Anonymous → 401; authenticated without the permission → 403. Superusers pass every
check; inactive users fail every check. Permissions (direct and via groups) are loaded
when the middleware loads the user.

**Ownership belongs in the query**, not in a permission:

```python
order = await Order.get_or_none(id=order_id, owner_id=ctx.user.id)
if order is None:
    not_found()                    # 404 hides whether it exists
```

Staff-style checks without the permissions tables: `useAuth()` plus
`if not ctx.user.is_staff: abort(403)`, or a `useAuth` subclass
(see `sillo-auth` references).

## Compose

- Authentication must be wired first — `sillo-auth`. User model — `sillo-users`.
- Tenant scoping as a global query scope — `sillo-record` (behaviour.md).
- Custom 403 bodies — `useAuth(forbidden=...)` or a `PermissionDenied` handler,
  `sillo-errors`.

## Verify

For each gated route: anonymous → 401, a user without the permission → 403, a user with
it (directly and via a group) → 2xx; for owned resources, another user's id → 404.
Include DELETE routes.

## Avoid

- `@app.delete(..., auth=useAuth(permissions=[...]))` in sillo-framework 1.0.0: the gate
  is not applied. Use `@router.delete(...)` or `Route(..., auth=...)`, and test it.
- `PermissionMixin` after `UserBaseModel` in the bases: the base's `has_permission` wins
  and denies everything.
- Checking ownership after fetching (`Order.get(id=…)` then compare): filter by owner.
- Storing permissions in the session or token; load them from the user.
- `@has_permission(...)` / `@auth(...)` decorators and `useAuth(scopes=...)` — removed.
