---
name: sillo-inertia
title: Inertia pages (React & Vue)
description: >-
  React or Vue pages with sillo-inertia: adapter, root view, render, shared/lazy/deferred props, form errors and flash, 303 redirects, Vite tags, axios CSRF, asset versioning.
intents:
  - create a dashboard page with Sillo Inertia
  - add an Inertia page for the users list
  - set up Inertia with React
  - show validation errors on the Vue form
  - share the current user with every page
  - flash a success message after saving
capabilities: [inertia]
related: [sillo-auth, sillo-sessions, sillo-security, sillo-routing, sillo-validation]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-inertia>=1.0", "@inertiajs/react or @inertiajs/vue3 (npm)", "vite"]
symbols:
  - sillo_inertia.Inertia
  - sillo_inertia.render
  - sillo_inertia.redirect
  - sillo_inertia.back
  - sillo_inertia.location
  - sillo_inertia.lazy
  - sillo_inertia.defer
  - sillo_inertia.always
  - sillo_inertia.optional
  - sillo_inertia.merge
  - sillo_inertia.vite_react
  - sillo_inertia.vite_vue
  - sillo_inertia.set_errors
  - sillo_inertia.set_flash
probes:
  - inertia_first_visit_html_then_json
  - inertia_version_mismatch_is_409
  - inertia_redirect_after_post_is_303
  - inertia_decimal_props_are_encoded
  - inertia_page_decorator
sources:
  - pkg:sillo-inertia/README.md
  - pkg:sillo-inertia/sillo_inertia/adapter.py
  - pkg:sillo-inertia/sillo_inertia/session.py
  - pkg:sillo-inertia/sillo_inertia/props.py
  - pkg:starter-inertia-vue/app/bootstrap.py
  - docs:v1.0/guides/inertia/index.md
status: stable
---

## When

Building page-based UIs where Sillo handlers return React or Vue page components with
props (no separate JSON API for the app's own front end). Pure JSON APIs need
`sillo-routing`/`sillo-responses` instead.

## Inspect first

- `sillo-inertia` in dependencies (`pip install sillo-inertia`), the adapter construction
  (often `app/inertia.py`), the root view HTML, `vite.config.*` and the JS entry
  (`js/main.ts` / `src/main.jsx`).
- Sessions and CSRF wiring: form errors and flash live in the session.

## How

**Adapter and root view:**

```python
from sillo_inertia import Inertia, vite_react

inertia = Inertia(
    root_view=BASE_DIR / "resources/views/app.html",
    base_dir=BASE_DIR,
    version=settings.asset_version,          # mismatch → 409 + full reload
    root_id="app",
    vite=vite_react(entry="src/main.jsx", dev=settings.vite_dev,
                    manifest_path=BASE_DIR / "static/build/.vite/manifest.json"),
)
inertia.middleware(app)                       # or Inertia(app, ...) to attach at once
inertia.share(app_name="Shop", auth=lambda ctx: {"user": public_user(ctx)})
```

```html
<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" />{{ inertia_head }}</head>
  <body><div id="{{ root_id }}"></div>{{ inertia }}</body>
</html>
```

`{{ inertia }}` is the page-object script tag (Inertia 2.x reads it); `{{ inertia_head }}`
renders Vite's dev or built tags. Use `vite_vue(...)` for Vue.

**Pages:**

```python
from sillo import HttpContext, Router
from sillo_inertia import render

pages = Router()

@pages.get("/dashboard", auth=useAuth(unauthorized=lambda ctx: redirect("/login")))
async def dashboard(ctx: HttpContext):
    return await render("Dashboard", {
        "stats": await dashboard_stats(ctx.user.id),
        "recent": lazy(lambda: recent_orders(ctx.user.id)),   # only on partial reloads when asked
    })
```

`render(component, props, status_code=, headers=, view_data=)` from `sillo_inertia`
finds the adapter through its middleware, so route modules never import the app. Props
may be values, callables (`lambda: …` or `lambda ctx: …`) or coroutine functions.
`@inertia.page("Users/Show")` turns a props-returning function into a page. Also
`defer(...)`, `optional(...)`, `always(...)`, `merge(...)`.

**Forms** — POST, then redirect (303 after POST/PUT/PATCH):

```python
from sillo_inertia import back, redirect, set_errors, set_flash

@pages.post("/users")
async def store(ctx: HttpContext):
    data = await ctx.json                        # axios posts JSON
    errors = validate_user(data)
    if errors:
        set_errors(ctx, errors)                  # → `errors` prop on the page redirected to
        return back(fallback="/users/create")
    await User.objects.create_user(**data)
    set_flash(ctx, "success", "User created.")
    return redirect("/users")
```

`errors` and `flash` are always-present props (read-and-clear from the session), which is
what Inertia's `useForm` reads. `location(url)` forces a full visit (external URLs).

**CSRF with axios** — axios sends `X-XSRF-TOKEN` from an `XSRF-TOKEN` cookie:

```python
CSRFMiddleware(config=CSRFConfig(enabled=True, cookie_name="XSRF-TOKEN",
                                 header_name="X-XSRF-TOKEN", cookie_httponly=False,
                                 secret_key=settings.secret_key))
```

Front-end setup, props serialisation and production builds:
[frontend.md](references/frontend.md).

## Compose

Session auth for pages — `sillo-auth` + `sillo-sessions`; CSRF and CSP (Vite dev server
origin) — `sillo-security`; routers — `sillo-routing`.

## Verify

`TestClient` with `headers={"X-Inertia": "true", "X-Inertia-Version": <version>}` returns
the page object as JSON (`component`, `props`); without the header the root HTML is
returned. Assert a POST answers 303. Run `npm run dev` + `sillo dev` and load the page.

## Avoid

- `data-page` on the root `<div>` (Inertia 1.x convention): current clients read the
  script tag from `{{ inertia }}`.
- 302 after a POST — use `redirect()`/`back()` (303), or the browser re-POSTs.
- Passing models or `to_dict()` output as props: every column (password hash included)
  reaches the browser. Build explicit dicts.
- Sillo's default CSRF names with axios (every POST 403s silently).
- `Shield()`'s default CSP in development: it blocks the Vite dev server script.
- Copying handler code from older starters that import `Request`/`Response` from
  `sillo.core.http`: that is the 0.x API and fails to import on 1.x.
