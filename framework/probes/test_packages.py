"""Official packages. Each test skips when its package is not installed."""

import pytest

from sillo import HttpContext, SilloApp
from sillo.testclient import TestClient

ROOT_VIEW = """<!DOCTYPE html>
<html><head>{{ inertia_head }}</head>
<body><div id="{{ root_id }}"></div>{{ inertia }}</body></html>
"""


def _inertia_app(tmp_path):
    inertia_mod = pytest.importorskip("sillo_inertia")
    view = tmp_path / "app.html"
    view.write_text(ROOT_VIEW)
    app = SilloApp()
    inertia = inertia_mod.Inertia(app, root_view=str(view), version="1", base_dir=str(tmp_path))
    return app, inertia, inertia_mod


def test_inertia_first_visit_html_then_json(tmp_path):
    app, inertia, mod = _inertia_app(tmp_path)
    inertia.share(app_name="Shop")

    @app.get("/")
    async def home(ctx: HttpContext):
        return await inertia.render("Home", {"name": "Sillo", "comments": mod.lazy(lambda: ["c1"])})

    client = TestClient(app)
    first = client.get("/")
    assert first.headers["content-type"].startswith("text/html")
    assert 'data-page="app"' in first.text and "Home" in first.text
    visit = client.get("/", headers={"X-Inertia": "true", "X-Inertia-Version": "1"})
    page = visit.json()
    assert visit.headers.get("x-inertia") == "true"
    assert page["component"] == "Home" and page["props"]["name"] == "Sillo"
    assert page["props"]["app_name"] == "Shop"
    partial = client.get("/", headers={"X-Inertia": "true", "X-Inertia-Version": "1",
                                       "X-Inertia-Partial-Component": "Home",
                                       "X-Inertia-Partial-Data": "comments"}).json()
    assert partial["props"]["comments"] == ["c1"] and "name" not in partial["props"]
    assert {"errors", "flash"} <= set(partial["props"])      # always present


def test_inertia_version_mismatch_is_409(tmp_path):
    app, inertia, _ = _inertia_app(tmp_path)

    @app.get("/")
    async def home(ctx: HttpContext):
        return await inertia.render("Home", {})

    r = TestClient(app).get("/", headers={"X-Inertia": "true", "X-Inertia-Version": "old"})
    assert r.status_code == 409 and r.headers.get("x-inertia-location")


def test_inertia_redirect_after_post_is_303(tmp_path):
    app, inertia, mod = _inertia_app(tmp_path)

    @app.post("/users")
    async def store(ctx: HttpContext):
        return mod.redirect("/users")

    r = TestClient(app, follow_redirects=False).post("/users", headers={"X-Inertia": "true", "X-Inertia-Version": "1"})
    assert r.status_code == 303 and r.headers["location"].endswith("/users")


def test_inertia_decimal_props_are_encoded(tmp_path):
    from decimal import Decimal

    app, inertia, _ = _inertia_app(tmp_path)

    @app.get("/")
    async def home(ctx: HttpContext):
        return await inertia.render("Home", {"price": Decimal("670.00")})

    page = TestClient(app).get("/", headers={"X-Inertia": "true", "X-Inertia-Version": "1"}).json()
    assert page["props"]["price"] == "670.00"


def test_inertia_page_decorator(tmp_path):
    app, inertia, _ = _inertia_app(tmp_path)

    @app.get("/users/{user_id:int}")
    @inertia.page("Users/Show")
    async def show(user_id: int):
        return {"user": {"id": user_id}}

    page = TestClient(app).get("/users/5", headers={"X-Inertia": "true", "X-Inertia-Version": "1"}).json()
    assert page["component"] == "Users/Show" and page["props"]["user"] == {"id": 5}
