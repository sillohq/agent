---
name: sillo-admin
title: Admin panel with Warder
description: >-
  A declarative admin for Sillo models with warder: Admin, Resource, List, Form, Column, Field, Action,
  Access, Gate, Scope, Role, create-admin, warder check, and mounting onto an app.
intents:
  - add an admin panel
  - let staff edit posts and orders
  - restrict which rows a staff member can see
  - add a bulk action to the admin list
  - create the first admin user
capabilities: [admin]
related: [sillo-users, sillo-auth, sillo-record, sillo-sessions, sillo-inertia]
requires: [sillo, sillo-record]
sillo: ">=1.0.0 <2.0.0"
packages: ["warder>=1.0", "sillo-framework[record]"]
symbols:
  - warder.Admin
  - warder.Resource
  - warder.List
  - warder.Form
  - warder.Detail
  - warder.Column
  - warder.Field
  - warder.Filter
  - warder.Action
  - warder.Section
  - warder.Sort
  - warder.Access
  - warder.Gate
  - warder.Scope
  - warder.Role
  - warder.Auth
  - warder.Theme
  - warder.notice
  - warder.current_user
probes: []
sources:
  - pkg:warder/README.md
  - pkg:warder/warder
  - docs:packages/warder/index.md
status: stable
---

## When

A back-office UI over existing models: list, search, edit, bulk actions, permissions. The
admin left the framework in 1.0; it is the separate `warder` package (Inertia + React, bundled,
no Node needed). Warder is alpha: MFA and impersonation are declarable but not yet enforced.

## Inspect first

- The Tortoise models to expose and the app's `setup_record(...)` call.
- The user model that signs in (`sillo-users`) and whether staff and customers share it.
- Whether the app already installs `SessionMiddleware`.

## How

```python
from warder import Access, Action, Admin, Column, Field, Filter, Form, List, Resource, Section, Sort, notice

admin = Admin(title="Acme Ops", prefix="/admin")

async def publish(ctx, rows):                       # actions get a queryset, not ids
    count = await rows.filter(status="draft").update(status="live")
    return notice(f"Published {count} posts")

admin.add(Resource(
    Post, group="Content",
    list=List(Column("title", link=True), Column.badge("status", colors={"live": "green"}),
              filters=[Filter.search("title", "body"), Filter.choice("status", ["draft", "live"])],
              actions=[Action("Publish", publish, confirm="Publish {count} posts?")],
              sort=Sort.desc("published_at")),
    form=Form(Section("Content", Field("title"), Field.markdown("body"))),
    access=Access(view=True, add="post.add", change=lambda ctx, row: row.author_id == ctx.user.id),
))
admin.mount(app)
```

- `Resource(Post)` alone already yields a list, form and detail inferred from the schema.
- A declaration is a value: `List(...).with_(Column("slug"))` returns a new one.
- Rule callables are always `(ctx, row)`, `row=None` for model-level questions; gates take `(ctx)`.
- Auth: `Admin()` works out of the box (bundled `AdminUser`, session backend, `Gate.staff()`).
  Opt in to the bundled tables with `model_modules=[..., "warder.models"]`. Customise with
  `Auth(users=User, gate=..., session=Session(...), login=Login(throttle="5/15m"))`.
- Permissions: `Gate` (may enter), `Access` (model / row / field), `Scope` (which rows exist
  for you, e.g. `Scope.tenant("team_id")`), `Role`s compile onto `sillo.permissions`;
  each Resource declares `<model>.view|add|change|delete`.
- CLI: `warder create-admin app.admin:admin`, `warder users`, `warder check`,
  `warder permissions`, `warder routes`.

## Compose

`sillo-record` for models and `setup_record`; `sillo-users` for the shared user model and
permissions; `sillo-sessions` (mount installs one if missing); `sillo-security` for CSP.

## Verify

`warder check app.admin:admin` resolves every column and relation against the models with no
server or database and exits non-zero on the first error; run it in CI. Then sign in at the
prefix and open each resource.

## Avoid

- `Admin(title=...)` with the app's shared user model and no `Gate`: the default `Gate.staff()`
  is what stops every registered account entering; do not loosen it casually.
- `Access` without `Scope` (leaks row existence through counts) or the reverse (writable by id).
- `ctx.user` inside rules when the middleware may be absent: use `current_user(ctx)`.
- Looking for an admin in `sillo` itself or in 0.x snippets: it was removed in 1.0.
- Annotation-driven behaviour: nothing here reads type hints.
