---
name: sillo-users
title: Users & passwords
description: >-
  The Sillo user model: UserBaseModel, UserManager, PasswordField, creating users,
  verifying credentials, password hashing and validation, and the sillo user:* commands.
intents:
  - add a users table
  - add a profile field to the user model
  - create an admin user
  - hash and check passwords
  - reset a user's password from the command line
  - enforce password strength
capabilities: [users, password_hashing]
related: [sillo-auth, sillo-authorization, sillo-record, sillo-migrations, sillo-cli]
requires: [sillo-record]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework[record]", "bcrypt or argon2-cffi (optional)"]
symbols:
  - sillo.users.UserBaseModel
  - sillo.users.UserManager
  - sillo.users.User
  - sillo.users.UserProtocol
  - sillo.users.SimpleUser
  - sillo.users.make_password
  - sillo.users.check_password
  - sillo.users.validate_password
  - sillo.users.UserManager.create_user
  - sillo.users.UserManager.create_superuser
  - sillo.users.UserManager.get_by_email
  - sillo.users.UserBaseModel.verify_credentials
  - sillo.users.UserBaseModel.set_password
  - sillo.users.UserBaseModel.check_password
  - sillo.record.fields.PasswordField
  - sillo.hashing.hash_password
  - sillo.hashing.verify_password
  - sillo.hashing.needs_rehash
probes:
  - password_field_hashes_and_verify_credentials_accepts_username
  - session_login_flow_with_auth_registered_before_session
sources:
  - core:sillo/users/base.py
  - core:sillo/users/managers.py
  - core:sillo/users/console.py
  - core:sillo/record/fields.py
  - core:sillo/hashing/core.py
  - pkg:starter/database/models/user.py
  - docs:v1.0/guides/users.md
  - docs:v1.0/cli/users.md
status: stable
---

## When

Defining or extending the user model, creating accounts (code or CLI), password hashing,
verification, strength rules and rehashing. Logging in is `sillo-auth`; roles and
permissions are `sillo-authorization`.

## Inspect first

- The project's user model (sillo-start: `database/models/user.py`) and whether it
  already binds `UserManager` and declares `PasswordField`.
- `model_modules` — it must not contain `sillo.users`.
- What the auth middleware is given as `user_model` (the `user:*` commands use the same
  model, via `app.auth_user_model`).

## How

**The model** — one users table, the pattern sillohq/starter ships:

```python
from sillo.record.fields import PasswordField
from sillo.users import UserBaseModel, UserManager
from tortoise import fields


class User(UserBaseModel):
    objects = UserManager()
    password = PasswordField()                               # hashes on save
    full_name = fields.CharField(max_length=150, null=True)  # your own fields

    class Meta:
        table = "users"


User.objects.contribute_to_class(User, "objects")           # bind the manager
```

`UserBaseModel` supplies `email`, `username`, `password`, `is_active`, `is_staff`,
`is_superuser`, `last_login`, `email_verified_at`, plus `identity`, `display_name`,
`is_authenticated`, `load_user`, `set_password`, `check_password`,
`verify_credentials`, `set_last_login`, `mark_email_verified`, `has_permission`.

**Creating and finding users:**

```python
user = await User.objects.create_user(email="ada@example.com", username="ada", password=raw)
admin = await User.objects.create_superuser(email="ops@example.com", username="ops", password=raw)
await User.objects.get_by_email("ada@example.com")
await User.objects.get_by_username("ada")
user = await User.verify_credentials("ada@example.com", raw)   # or the username; None on failure
```

**Passwords.** `user.set_password(raw)` then `await user.save()`; `user.check_password(raw)`.
Standalone: `from sillo.hashing import hash_password, verify_password, needs_rehash`.
Strength rules: `validate_password(raw)` returns a list of problems (empty means OK).
bcrypt is used when installed (`sillo-framework[hashing-bcrypt]`), argon2 with
`[hashing-argon2]`; otherwise a PBKDF2 fallback. Rehash on login when
`needs_rehash(user.password)` is true.

**From the command line** (needs the app's database wiring; passwords are prompted):

```bash
sillo user:create ada@example.com ada        # --admin for staff access
sillo user:admin ops@example.com             # an administrator
sillo user:password ada@example.com
sillo user:list --staff
sillo user:show ada ; sillo user:active ada --off ; sillo user:staff ada
```

Custom (non-database) users implement `sillo.users.UserProtocol`; `SimpleUser` is the
in-memory one for tests. Details: [custom-users.md](references/custom-users.md).

## Compose

- Login/logout/tokens — `sillo-auth`. Permissions — `sillo-authorization` (add
  `PermissionMixin` to this model).
- New columns need a migration — `sillo-migrations`.
- Admin panel users (warder) reuse this model — `sillo-admin`.

## Verify

Create a user in a test and assert the stored `password` is not the plaintext, that
`verify_credentials` succeeds with email and username and fails with a wrong password
and for an inactive account. `sillo user:list` shows accounts created via the CLI.

## Avoid

- Omitting `password = PasswordField()`: the inherited field stores whatever it is given,
  so `user.password = "hunter2"; await user.save()` writes plaintext.
- Forgetting `User.objects.contribute_to_class(User, "objects")`: the manager falls back
  to Sillo's built-in `User`, which is not registered — "default_connection … cannot be
  None".
- Adding `sillo.users` to `model_modules`: its `User` displaces yours (columns silently
  missing).
- Declaring fields named `identity`, `display_name` or `is_authenticated` — they are
  read-only properties on the base class.
- Comparing hashes with `==`; use `check_password` / `verify_password`.
