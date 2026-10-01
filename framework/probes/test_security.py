"""Sessions, CORS, CSRF, security headers, rate limiting, API keys and permissions."""

import pytest

from sillo import HttpContext, SilloApp, json
from sillo.testclient import TestClient

SECRET = "probe-secret-probe-secret-probe-secret"


def test_session_persists_only_when_cookie_secure_is_off_over_http():
    from sillo.session import SessionConfig, SessionMiddleware

    def build(secure: bool) -> SilloApp:
        app = SilloApp()
        app.use(SessionMiddleware(config=SessionConfig(session_cookie_secure=secure), secret_key=SECRET))

        @app.get("/count")
        async def count(ctx: HttpContext):
            ctx.session["n"] = ctx.session.get("n", 0) + 1
            return {"n": ctx.session["n"]}

        return app

    insecure = TestClient(build(False))
    assert [insecure.get("/count").json()["n"] for _ in range(3)] == [1, 2, 3]
    default = TestClient(build(True))  # the default, over plain http
    assert [default.get("/count").json()["n"] for _ in range(3)] == [1, 1, 1]


def test_session_middleware_rejects_unknown_settings():
    from sillo.session import SessionMiddleware

    with pytest.raises(TypeError):
        SessionMiddleware(secret_key=SECRET, cookie_secure=False)


def test_cors_allowed_origin_and_preflight():
    from sillo.security import CORSMiddleware, CorsConfig

    app = SilloApp()
    app.use(CORSMiddleware(config=CorsConfig(allow_origins=["https://app.example.com"],
                                             allow_methods=["GET", "POST"], allow_credentials=True)))

    @app.post("/data")
    async def data(ctx: HttpContext):
        return {"ok": True}

    client = TestClient(app)
    simple = client.post("/data", headers={"Origin": "https://app.example.com"})
    assert simple.headers["access-control-allow-origin"] == "https://app.example.com"
    assert simple.headers["access-control-allow-credentials"] == "true"
    pre = client.options("/data", headers={"Origin": "https://app.example.com",
                                           "Access-Control-Request-Method": "POST"})
    assert pre.status_code in (200, 201, 204) and "POST" in pre.headers["access-control-allow-methods"]
    evil = client.post("/data", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in evil.headers


def test_csrf_is_disabled_by_default_and_enforced_when_enabled():
    from sillo.security import CSRFConfig, CSRFMiddleware

    assert CSRFConfig().enabled is False
    app = SilloApp()
    app.use(CSRFMiddleware(config=CSRFConfig(enabled=True, secret_key=SECRET)))

    @app.get("/form")
    async def form(ctx: HttpContext):
        return {"token": ctx.state.csrf_token}

    @app.post("/transfer")
    async def transfer(ctx: HttpContext):
        return {"ok": True}

    client = TestClient(app)
    assert client.post("/transfer").status_code == 403
    primed = client.get("/form")
    token = primed.cookies["csrftoken"]
    assert primed.json()["token"]
    assert client.post("/transfer", headers={"X-CSRFToken": token}).status_code == 200


def test_shield_sets_security_headers():
    from sillo.security import Shield

    app = SilloApp()
    app.use(Shield())

    @app.get("/")
    async def home(ctx: HttpContext):
        return {"ok": True}

    headers = TestClient(app).get("/").headers
    assert headers["x-frame-options"] == "DENY"
    assert "content-security-policy" in headers
    assert headers["strict-transport-security"].startswith("max-age=")
    assert headers["x-content-type-options"] == "nosniff"


def test_rate_limit_scoping_what_works_and_what_500s():
    """RateLimit is raw ASGI: app.use and router.use accept it; route/router middleware lists do not."""
    from sillo import Router
    from sillo.security import RateLimit

    def limiter():
        return RateLimit(limit=2, window=60, key_func=lambda ctx: "same")

    # router.use(RateLimit(...)) limits just that router.
    app = SilloApp()
    auth = Router(prefix="/auth")
    auth.use(limiter())

    @auth.post("/login")
    async def login(ctx: HttpContext):
        return {"ok": True}

    app.mount_router(auth)

    @app.get("/other")
    async def other(ctx: HttpContext):
        return {"ok": True}

    client = TestClient(app, raise_server_exceptions=False)
    statuses = [client.post("/auth/login").status_code for _ in range(3)]
    assert statuses == [200, 200, 429]
    assert client.get("/other").status_code == 200

    # A dispatch wrapper around .check() works as route middleware.
    shared = limiter()

    async def login_limit(ctx: HttpContext, call_next):
        result = await shared.check(ctx)
        if result is not None and not result.allowed:
            return json({"error": "too_many_attempts"}, status_code=429)
        return await call_next()

    app2 = SilloApp()

    @app2.post("/login", middleware=[login_limit])
    async def login2(ctx: HttpContext):
        return {"ok": True}

    c2 = TestClient(app2)
    assert [c2.post("/login").status_code for _ in range(3)] == [200, 200, 429]

    # Passing RateLimit itself as route middleware is a 500.
    app3 = SilloApp()

    @app3.post("/login", middleware=[limiter()])
    async def login3(ctx: HttpContext):
        return {"ok": True}

    assert TestClient(app3, raise_server_exceptions=False).post("/login").status_code == 500


def test_app_wide_rate_limit_headers():
    from sillo.security import RateLimit

    app = SilloApp()
    app.use(RateLimit(limit=2, window=60, key_func=lambda ctx: "h"))

    @app.get("/")
    async def home(ctx: HttpContext):
        return {"ok": True}

    client = TestClient(app)
    first = client.get("/")
    assert first.headers["x-ratelimit-limit"] == "2" and first.headers["x-ratelimit-remaining"] == "1"
    client.get("/")
    denied = client.get("/")
    assert denied.status_code == 429 and denied.headers["retry-after"].isdigit()


def test_rate_limit_default_key_follows_x_forwarded_for():
    """Without key_func, the client key comes from spoofable forwarding headers."""
    from sillo.security import RateLimit

    app = SilloApp()
    app.use(RateLimit(limit=1, window=60))

    @app.get("/")
    async def home(ctx: HttpContext):
        return {"ok": True}

    client = TestClient(app)
    assert client.get("/", headers={"x-forwarded-for": "1.1.1.1"}).status_code == 200
    assert client.get("/", headers={"x-forwarded-for": "1.1.1.1"}).status_code == 429
    assert client.get("/", headers={"x-forwarded-for": "2.2.2.2"}).status_code == 200


@pytest.fixture
def record_app():
    pytest.importorskip("tortoise")
    from sillo.auth import AuthenticationMiddleware
    from sillo.auth.apikey import APIKeyAuthBackend
    from sillo.auth.jwt_auth import JWTAuthBackend
    from sillo.record import DatabaseConfig, setup_record

    from probe_auth_models import Account

    app = SilloApp()
    app.use(AuthenticationMiddleware(
        user_model=Account,
        backend=[APIKeyAuthBackend(header_name="X-API-Key", verify_with_manager=True),
                 JWTAuthBackend(secret_key=SECRET, identifier="sub")],
    ))
    setup_record(app, DatabaseConfig.sqlite(":memory:"), model_modules=["probe_auth_models"])
    return app


def test_api_key_issue_and_authenticate(record_app):
    from sillo.auth import useAuth

    from probe_auth_models import Account

    app = record_app

    @app.post("/keys")
    async def keys(ctx: HttpContext):
        user = await Account.objects.create_user(email="k@example.com", username="k", password="Str0ngPass!")
        full_key, row = await user.create_api_key(name="ci")
        return {"key": full_key}

    @app.get("/whoami", auth=useAuth())
    async def whoami(ctx: HttpContext):
        return {"email": ctx.user.email, "scheme": ctx.scope.get("auth")}

    with TestClient(app) as client:
        key = client.post("/keys").json()["key"]
        assert client.get("/whoami").status_code == 401
        r = client.get("/whoami", headers={"X-API-Key": key})
        assert r.status_code == 200 and r.json()["email"] == "k@example.com"


def test_permissions_gate_with_groups(record_app):
    from sillo.auth import useAuth
    from sillo.auth.jwt_auth import TokenForUser
    from sillo.permissions import Group, Permission

    from probe_auth_models import Account

    app = record_app

    @app.post("/setup")
    async def setup(ctx: HttpContext):
        editor = await Account.objects.create_user(email="e@example.com", username="e", password="Str0ngPass!")
        viewer = await Account.objects.create_user(email="v@example.com", username="v", password="Str0ngPass!")
        await Permission.define("posts:delete")
        editors = await Group.get_or_create("editors")
        await editors.add_permissions("posts:delete")
        await editors.add_user(editor)
        return {
            "editor": TokenForUser(editor, secret=SECRET).access_token(),
            "viewer": TokenForUser(viewer, secret=SECRET).access_token(),
        }

    from sillo import Router

    posts = Router(prefix="/posts")  # app.delete drops auth= in 1.0.0; routers do not

    @posts.delete("/1", auth=useAuth(permissions=["posts:delete"]))
    async def delete_post(ctx: HttpContext):
        return {"deleted": True}

    app.mount_router(posts)

    with TestClient(app) as client:
        tokens = client.post("/setup").json()
        assert client.delete("/posts/1").status_code == 401
        assert client.delete("/posts/1", headers={"Authorization": f"Bearer {tokens['viewer']}"}).status_code == 403
        assert client.delete("/posts/1", headers={"Authorization": f"Bearer {tokens['editor']}"}).status_code == 200


def test_app_delete_and_options_ignore_auth_in_1_0_0():
    """KNOWN BUG (sillo-framework 1.0.0): SilloApp.delete/.options and add_route(path=...)
    accept auth= but never apply it. Router decorators and Route(...) objects do.
    When this probe starts failing, the bug is fixed: update sillo-auth's guidance."""
    from sillo import Route, Router
    from sillo.auth import AuthenticationMiddleware, useAuth
    from sillo.auth.jwt_auth import JWTAuthBackend
    from sillo.users import SimpleUser

    app = SilloApp()
    app.use(AuthenticationMiddleware(user_model=SimpleUser, backend=JWTAuthBackend(secret_key=SECRET, identifier="sub")))

    async def handler(ctx: HttpContext):
        return {"ok": True}

    app.delete("/app-delete", handler=handler, auth=useAuth())
    app.options("/app-options", handler=handler, auth=useAuth())
    app.get("/app-get", handler=handler, auth=useAuth())
    app.add_route(path="/add-route", methods=["DELETE"], handler=handler, auth=useAuth())
    app.add_route(Route("/route-object", handler, methods=["DELETE"], auth=useAuth()))
    router = Router(prefix="/r")
    router.delete("/x", auth=useAuth())(handler)
    app.mount_router(router)

    client = TestClient(app, raise_server_exceptions=False)
    assert client.delete("/app-delete").status_code == 200      # unprotected
    assert client.options("/app-options").status_code == 200    # unprotected
    assert client.delete("/add-route").status_code == 200       # unprotected
    assert client.get("/app-get").status_code == 401
    assert client.delete("/route-object").status_code == 401
    assert client.delete("/r/x").status_code == 401


def test_shield_defaults_block_cdn_scripts_and_duplicate_cache_control():
    from sillo.security import Shield

    app = SilloApp()
    app.use(Shield())

    @app.get("/cached")
    async def cached(ctx: HttpContext):
        return json({}).cache(max_age=60, private=False)

    client = TestClient(app)
    r = client.get("/cached")
    assert r.headers.get_list("cache-control") == ["public, max-age=60", "no-store, no-cache, must-revalidate, proxy-revalidate"]
    assert r.headers["cross-origin-embedder-policy"] == "require-corp"
    docs = client.get("/docs")
    assert "script-src 'self';" in docs.headers["content-security-policy"]
    assert "https://cdn.jsdelivr.net" in docs.text or "https://unpkg.com" in docs.text


def test_redis_rate_limit_backend_signature():
    import inspect

    from sillo.security import RedisBackend

    assert "url" in inspect.signature(RedisBackend.__init__).parameters
