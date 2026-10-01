"""Authentication, sessions, users, and the record wiring they depend on."""

import inspect

import pytest

pytest.importorskip("tortoise")

from sillo import HttpContext, Router, SilloApp, json  # noqa: E402
from sillo.auth import AuthenticationMiddleware, useAuth  # noqa: E402
from sillo.auth.jwt_auth import JWTAuthBackend, TokenForUser  # noqa: E402
from sillo.auth.session_auth import SessionAuthBackend, login, logout  # noqa: E402
from sillo.record import DatabaseConfig, setup_record  # noqa: E402
from sillo.session import SessionConfig, SessionMiddleware  # noqa: E402
from sillo.testclient import TestClient  # noqa: E402

MODELS = ["probe_models"]
SECRET = "probe-secret-probe-secret-probe-secret"


def _session_app(order: str = "correct") -> SilloApp:
    from probe_models import User

    app = SilloApp()
    auth = AuthenticationMiddleware(user_model=User, backend=SessionAuthBackend())
    session = SessionMiddleware(
        config=SessionConfig(session_cookie_secure=False), secret_key=SECRET
    )
    if order == "correct":
        app.use(auth)  # innermost: needs ctx.session, so registered first
        app.use(session)
    else:
        app.use(session)
        app.use(auth)
    setup_record(app, DatabaseConfig.sqlite(":memory:"), model_modules=MODELS)

    @app.post("/register")
    async def register(ctx: HttpContext):
        data = await ctx.json
        user = await User.objects.create_user(
            email=data["email"], username=data["username"], password=data["password"]
        )
        return json({"id": user.id}, status_code=201)

    @app.post("/login")
    async def do_login(ctx: HttpContext):
        data = await ctx.json
        user = await User.verify_credentials(data["email"], data["password"])
        if user is None:
            return json({"detail": "Invalid credentials."}, status_code=401)
        login(ctx, user)
        return {"ok": True}

    @app.post("/logout")
    async def do_logout(ctx: HttpContext):
        logout(ctx)
        return {"ok": True}

    @app.get("/me", auth=useAuth())
    async def me(ctx: HttpContext):
        return {"email": ctx.user.email}

    @app.get("/feed", auth=useAuth(required=False))
    async def feed(ctx: HttpContext):
        return {"authenticated": ctx.user.is_authenticated}

    return app


def test_session_login_flow_with_auth_registered_before_session():
    app = _session_app("correct")
    with TestClient(app) as client:
        creds = {"email": "a@example.com", "username": "alice", "password": "Str0ngPass!"}
        assert client.post("/register", json=creds).status_code == 201
        assert client.get("/me").status_code == 401
        assert client.get("/feed").json() == {"authenticated": False}
        assert client.post("/login", json={"email": creds["email"], "password": "nope"}).status_code == 401
        assert client.post("/login", json=creds).status_code == 200
        assert client.get("/me").json() == {"email": "a@example.com"}
        client.post("/logout")
        assert client.get("/me").status_code == 401


def test_session_before_auth_registration_breaks_login():
    """Registering SessionMiddleware first puts auth outside it: no user ever loads."""
    app = _session_app("wrong")
    with TestClient(app, raise_server_exceptions=False) as client:
        creds = {"email": "b@example.com", "username": "bob", "password": "Str0ngPass!"}
        client.post("/register", json=creds)
        client.post("/login", json=creds)
        assert client.get("/me").status_code != 200


def test_password_field_hashes_and_verify_credentials_accepts_username():
    from probe_models import User

    app = _session_app()

    @app.get("/check")
    async def check(ctx: HttpContext):
        user = await User.objects.create_user(
            email="c@example.com", username="carol", password="Str0ngPass!"
        )
        fresh = await User.get(id=user.id)
        by_username = await User.verify_credentials("carol", "Str0ngPass!")
        return {
            "plaintext_stored": fresh.password == "Str0ngPass!",
            "by_username": by_username is not None,
        }

    with TestClient(app) as client:
        assert client.get("/check").json() == {
            "plaintext_stored": False,
            "by_username": True,
        }


def test_jwt_backend_needs_identifier_sub():
    from probe_models import User

    def build(identifier: str) -> SilloApp:
        app = SilloApp()
        app.use(
            AuthenticationMiddleware(
                user_model=User,
                backend=JWTAuthBackend(secret_key=SECRET, identifier=identifier),
            )
        )
        setup_record(app, DatabaseConfig.sqlite(":memory:"), model_modules=MODELS)

        @app.post("/token")
        async def token(ctx: HttpContext):
            user = await User.objects.create_user(
                email="d@example.com", username="dan", password="Str0ngPass!"
            )
            return TokenForUser(user, secret=SECRET).token_pair()

        @app.get("/me", auth=useAuth())
        async def me(ctx: HttpContext):
            return {"email": ctx.user.email}

        return app

    for identifier, expected in (("sub", 200), ("id", 401)):
        with TestClient(build(identifier)) as client:
            pair = client.post("/token").json()
            assert pair["token_type"] == "bearer"
            r = client.get("/me", headers={"Authorization": f"Bearer {pair['access_token']}"})
            assert r.status_code == expected, identifier


def test_useauth_signature_and_router_has_no_auth_argument():
    """The protecting-routes guide shows Router(prefix=..., auth=useAuth()); it does not exist."""
    params = inspect.signature(useAuth.__init__).parameters
    for name in ("permissions", "schemes", "required", "backends", "unauthorized", "forbidden"):
        assert name in params
    assert "auth" not in inspect.signature(Router.__init__).parameters


def test_useauth_unauthorized_hook_replaces_401():
    from sillo import redirect

    app = _session_app()

    @app.get("/dashboard", auth=useAuth(unauthorized=lambda ctx: redirect("/login")))
    async def dashboard(ctx: HttpContext):
        return {}

    with TestClient(app, follow_redirects=False) as client:
        r = client.get("/dashboard")
        assert r.status_code == 302 and r.headers["location"] == "/login"


def test_setup_record_puts_manager_on_app_state():
    app = SilloApp()
    manager = setup_record(app, DatabaseConfig.sqlite(":memory:"), model_modules=MODELS)
    assert app.state["record"] is manager
    assert "model_modules" in inspect.signature(setup_record).parameters


def test_generate_schemas_defaults_on_and_session_cookie_secure_defaults_on():
    import os

    os.environ.pop("DB_GENERATE_SCHEMAS", None)
    assert DatabaseConfig.sqlite(":memory:").generate_schemas is True
    assert SessionConfig().session_cookie_secure is True


def _jwt_app(record_first: bool, via_constructor: bool = False) -> SilloApp:
    from probe_models import User

    backend = JWTAuthBackend(secret_key=SECRET, identifier="sub")
    app = SilloApp(auth=[backend], auth_user_model=User) if via_constructor else SilloApp()
    if record_first:
        setup_record(app, DatabaseConfig.sqlite(":memory:"), model_modules=MODELS)
    if not via_constructor:
        app.use(AuthenticationMiddleware(user_model=User, backend=backend))
    if not record_first:
        setup_record(app, DatabaseConfig.sqlite(":memory:"), model_modules=MODELS)

    @app.post("/token")
    async def token(ctx: HttpContext):
        user = await User.objects.create_user(email="o@example.com", username="o", password="Str0ngPass!")
        return TokenForUser(user, secret=SECRET).token_pair()

    @app.get("/me", auth=useAuth())
    async def me(ctx: HttpContext):
        return {"email": ctx.user.email}

    return app


@pytest.mark.parametrize(
    "record_first,via_constructor,expected",
    [(False, False, 200), (True, False, 401), (False, True, 200)],
)
def test_setup_record_must_come_after_auth_middleware(record_first, via_constructor, expected):
    """setup_record's DB context must be outside auth, or users never load (401)."""
    with TestClient(_jwt_app(record_first, via_constructor), raise_server_exceptions=False) as client:
        access = client.post("/token").json()["access_token"]
        assert client.get("/me", headers={"Authorization": f"Bearer {access}"}).status_code == expected


def test_stateless_refresh_recipe_rejects_access_tokens():
    from probe_models import User

    app = SilloApp()
    setup_record(app, DatabaseConfig.sqlite(":memory:"), model_modules=MODELS)

    @app.post("/token")
    async def token(ctx: HttpContext):
        user = await User.objects.create_user(email="r@example.com", username="r", password="Str0ngPass!")
        return TokenForUser(user, secret=SECRET).token_pair()

    from sillo.helpers.jwt import TokenError

    @app.post("/refresh")
    async def refresh(ctx: HttpContext):
        raw = (await ctx.json).get("refresh_token", "")
        try:
            claims = TokenForUser.decode_unverified(raw)
            user = await User.load_user(str(claims.get("sub", "")))
            if user is None or claims.get("typ") != "refresh":
                raise ValueError("not a refresh token")
            TokenForUser(user, secret=SECRET).verify(raw)
        except (TokenError, ValueError):
            return json({"detail": "Invalid refresh token."}, status_code=401)
        return TokenForUser(user, secret=SECRET).token_pair()

    with TestClient(app) as client:
        pair = client.post("/token").json()
        assert client.post("/refresh", json={"refresh_token": pair["refresh_token"]}).status_code == 200
        assert client.post("/refresh", json={"refresh_token": pair["access_token"]}).status_code == 401
        assert client.post("/refresh", json={"refresh_token": "garbage"}).status_code == 401
