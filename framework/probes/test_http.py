"""Routing, handlers, the context, responses, dependency injection, middleware."""

import inspect

import pytest

from sillo import Depend, HttpContext, Query, SilloApp, json
from sillo.core.routing import Router
from sillo.testclient import TestClient


def test_no_app_route_decorator():
    """The routing guide shows @app.route(...); SilloApp has no such method."""
    assert not hasattr(SilloApp, "route")
    for verb in ("get", "post", "put", "patch", "delete", "head", "options"):
        assert hasattr(SilloApp, verb)


def test_handler_returns_plain_value_as_json():
    app = SilloApp()

    @app.get("/x")
    async def x(ctx: HttpContext):
        return {"ok": True}

    r = TestClient(app).get("/x")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.json() == {"ok": True}


def test_returned_string_is_text_plain_not_html():
    app = SilloApp()

    @app.get("/x")
    async def x(ctx: HttpContext):
        return "<h1>hi</h1>"

    r = TestClient(app).get("/x")
    assert r.headers["content-type"].startswith("text/plain")


def test_path_converter_binds_typed_parameter():
    app = SilloApp()

    @app.get("/users/{user_id:int}")
    async def show(ctx: HttpContext, user_id: int):
        return {"type": type(user_id).__name__}

    client = TestClient(app)
    assert client.get("/users/7").json() == {"type": "int"}
    assert client.get("/users/abc").status_code in (404, 422)


def test_literal_route_beats_parameter_regardless_of_order():
    app = SilloApp()

    @app.get("/users/{user_id}")
    async def by_id(ctx: HttpContext, user_id: str):
        return {"kind": "id"}

    @app.get("/users/me")
    async def me(ctx: HttpContext):
        return {"kind": "me"}

    assert TestClient(app).get("/users/me").json() == {"kind": "me"}


def test_ctx_json_is_awaited_without_parentheses():
    app = SilloApp()

    @app.post("/x")
    async def x(ctx: HttpContext):
        data = await ctx.json
        return {"got": data}

    r = TestClient(app).post("/x", json={"a": 1})
    assert r.json() == {"got": {"a": 1}}


def test_depend_get_context_defaults_to_false():
    """Changed in 1.0.0rc1. Much of the v1.0 guide text still says True."""
    params = inspect.signature(Depend.__init__).parameters
    assert params["get_context"].default is False
    assert "use_cache" not in params  # documented, never implemented

    app = SilloApp()

    def settings():
        return {"debug": False}

    def client_host(ctx):
        return type(ctx).__name__

    @app.get("/x")
    async def x(
        ctx: HttpContext,
        cfg=Depend(settings),
        who=Depend(client_host, get_context=True),
    ):
        return {"cfg": cfg, "who": who}

    assert TestClient(app).get("/x").json() == {
        "cfg": {"debug": False},
        "who": "HttpContext",
    }


def test_dependency_can_declare_extractors():
    app = SilloApp()

    def pagination(page: int = Query(1, type=int), size: int = Query(20, type=int)):
        return {"offset": (page - 1) * size, "limit": size}

    @app.get("/items")
    async def items(ctx: HttpContext, p=Depend(pagination)):
        return p

    assert TestClient(app).get("/items?page=3&size=10").json() == {
        "offset": 20,
        "limit": 10,
    }


def test_yield_dependency_runs_finally_not_code_after_bare_yield():
    """The guide says the generator is resumed; it is closed, so only finally runs."""
    events: list[str] = []
    app = SilloApp()

    async def resource():
        events.append("open")
        try:
            yield "r"
            events.append("after-yield")
        finally:
            events.append("finally")

    @app.get("/x")
    async def x(ctx: HttpContext, r=Depend(resource)):
        return {"r": r}

    TestClient(app).get("/x")
    assert "open" in events and "finally" in events
    assert "after-yield" not in events


def test_dependency_override_context_manager():
    app = SilloApp()

    def real():
        return "real"

    @app.get("/x")
    async def x(ctx: HttpContext, v=Depend(real)):
        return {"v": v}

    client = TestClient(app)
    with app.override(real, lambda: "fake"):
        assert client.get("/x").json() == {"v": "fake"}
    assert client.get("/x").json() == {"v": "real"}


def test_last_use_is_outermost_middleware():
    """app.use() inserts at the front: the last call runs first on the way in."""
    order: list[str] = []
    app = SilloApp()

    def make(name):
        async def mw(ctx: HttpContext, call_next):
            order.append(name)
            return await call_next()

        return mw

    app.use(make("first-registered"))
    app.use(make("last-registered"))

    @app.get("/x")
    async def x(ctx: HttpContext):
        return {}

    TestClient(app).get("/x")
    assert order == ["last-registered", "first-registered"]


def test_middleware_short_circuit_and_call_next_takes_no_args():
    app = SilloApp()

    async def gate(ctx: HttpContext, call_next):
        if ctx.headers.get("x-key") != "k":
            return json({"error": "no"}, status_code=401)
        return await call_next()

    app.use(gate)

    @app.get("/x")
    async def x(ctx: HttpContext):
        return {"ok": True}

    client = TestClient(app)
    assert client.get("/x").status_code == 401
    assert client.get("/x", headers={"x-key": "k"}).status_code == 200


def test_lifespan_replaces_on_startup_hooks():
    """Passing lifespan= means on_startup hooks (and setup_* helpers) never run."""
    from contextlib import asynccontextmanager

    ran: list[str] = []

    @asynccontextmanager
    async def lifespan(app):
        ran.append("lifespan")
        yield

    app = SilloApp(lifespan=lifespan)

    @app.on_startup
    async def hook():
        ran.append("on_startup")

    @app.get("/x")
    async def x(ctx: HttpContext):
        return {}

    with TestClient(app) as client:
        client.get("/x")
    assert ran == ["lifespan"]


def test_testclient_runs_lifespan_only_as_context_manager():
    ran: list[str] = []
    app = SilloApp()

    @app.on_startup
    async def hook():
        ran.append("startup")

    @app.get("/x")
    async def x(ctx: HttpContext):
        return {}

    TestClient(app).get("/x")
    assert ran == []
    with TestClient(app) as client:
        client.get("/x")
    assert ran == ["startup"]


def test_shutdown_hooks_run_in_registration_order():
    ran: list[str] = []
    app = SilloApp()

    @app.on_shutdown
    async def a():
        ran.append("a")

    @app.on_shutdown
    async def b():
        ran.append("b")

    with TestClient(app):
        pass
    assert ran == ["a", "b"]


def test_router_prefix_and_mount():
    app = SilloApp()
    api = Router(prefix="/api")

    @api.get("/ping")
    async def ping(ctx: HttpContext):
        return {"pong": True}

    app.mount_router(api)
    assert TestClient(app).get("/api/ping").json() == {"pong": True}


def test_url_for_on_context():
    app = SilloApp()

    @app.get("/users/{user_id:int}", name="user_show")
    async def show(ctx: HttpContext, user_id: int):
        return {"url": str(ctx.url_for("user_show", user_id=5))}

    assert TestClient(app).get("/users/1").json()["url"].endswith("/users/5")


def test_debug_defaults_off():
    assert SilloApp().debug is False


@pytest.mark.parametrize(
    "builder,status",
    [("created", 201), ("accepted", 202), ("no_content", 204), ("empty", 204)],
)
def test_status_shorthand_builders(builder, status):
    import sillo

    app = SilloApp()
    fn = getattr(sillo, builder)

    @app.post("/x")
    async def x(ctx: HttpContext):
        return fn()

    assert TestClient(app).post("/x").status_code == status


def test_abort_raises_and_body_is_detail():
    from sillo import abort

    app = SilloApp()

    @app.get("/x")
    async def x(ctx: HttpContext):
        abort(403, detail="Admins only")

    r = TestClient(app).get("/x")
    assert r.status_code == 403
    assert "Admins only" in r.text


def test_response_model_filters_returned_dict_but_not_built_response():
    from pydantic import BaseModel

    class Out(BaseModel):
        id: int

    app = SilloApp()

    @app.get("/plain", response_model=Out)
    async def plain(ctx: HttpContext):
        return {"id": 1, "secret": "x"}

    @app.get("/built", response_model=Out)
    async def built(ctx: HttpContext):
        return json({"id": 1, "secret": "x"})

    client = TestClient(app)
    assert client.get("/plain").json() == {"id": 1}
    assert client.get("/built").json() == {"id": 1, "secret": "x"}


def test_request_model_injects_validated_body_and_422s():
    from pydantic import BaseModel

    class In(BaseModel):
        name: str
        price: float

    app = SilloApp()

    @app.post("/items", request_model=In)
    async def create(ctx: HttpContext, item):
        return {"name": item.name, "same": item is ctx.validated_data}

    client = TestClient(app)
    assert client.post("/items", json={"name": "a", "price": 1}).json() == {
        "name": "a",
        "same": True,
    }
    assert client.post("/items", json={"name": "a"}).status_code == 422


def test_query_marker_validates_and_422_names_location():
    app = SilloApp()

    @app.get("/x")
    async def x(ctx: HttpContext, limit=Query(10, type=int, ge=1, le=100)):
        return {"limit": limit}

    client = TestClient(app)
    assert client.get("/x?limit=5").json() == {"limit": 5}
    bad = client.get("/x?limit=500")
    assert bad.status_code == 422
    assert "query" in bad.text and "limit" in bad.text


def test_marker_type_gives_422_annotation_alone_gives_500():
    """Validation lives on the marker. An annotation converts but does not validate."""
    app = SilloApp()

    @app.get("/annotated")
    async def annotated(ctx: HttpContext, page: int = Query(1)):
        return {"page": page}

    @app.get("/marker")
    async def marker(ctx: HttpContext, page=Query(1, type=int)):
        return {"page": page}

    @app.get("/required")
    async def required(ctx: HttpContext, page=Query(type=int, required=True)):
        return {"page": page}

    @app.get("/ellipsis")
    async def ellipsis(ctx: HttpContext, page: int = Query(...)):
        return {"page": page}

    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/annotated?page=3").json() == {"page": 3}
    assert client.get("/annotated?page=x").status_code == 500
    assert client.get("/marker?page=x").status_code == 422
    assert client.get("/required").status_code == 422
    # Query(...) is not "required" unless strict_validation is on.
    assert client.get("/ellipsis").json() == {"page": None}


def test_strict_validation_turns_annotation_errors_into_422():
    app = SilloApp(strict_validation=True)

    @app.get("/annotated")
    async def annotated(ctx: HttpContext, page: int = Query(1)):
        return {"page": page}

    assert TestClient(app).get("/annotated?page=x").status_code == 422


def test_http_exception_takes_status_code_not_status():
    from sillo.exceptions import HTTPException

    params = inspect.signature(HTTPException.__init__).parameters
    assert "status_code" in params and "status" not in params


def test_mount_order_does_not_matter_in_1x():
    """0.x needed the most specific router mounted first; 1.x orders by specificity across mounts."""
    app = SilloApp()
    api = Router(prefix="/api")
    auth = Router(prefix="/api/auth")

    @api.get("/{rest:path}")
    async def catch_all(ctx: HttpContext, rest: str):
        return {"r": "catch-all"}

    @auth.get("/login")
    async def login(ctx: HttpContext):
        return {"r": "auth"}

    app.mount_router(api)  # broader prefix first, on purpose
    app.mount_router(auth)
    assert TestClient(app).get("/api/auth/login").json() == {"r": "auth"}


def test_prefixless_router_does_not_swallow_later_routes():
    app = SilloApp()
    spa = Router()

    @spa.get("/{rest:path}")
    async def spa_page(ctx: HttpContext, rest: str):
        return {"r": "spa"}

    app.mount_router(spa)

    @app.get("/health")
    async def health(ctx: HttpContext):
        return {"r": "health"}

    assert TestClient(app).get("/health").json() == {"r": "health"}


def test_static_files_mount_through_group_and_head_is_405(tmp_path):
    from sillo.core.routing import Group
    from sillo.static import StaticFiles

    (tmp_path / "a.txt").write_text("hello")
    app = SilloApp()
    app.add_route(Group(path="/static", app=StaticFiles(directory=str(tmp_path))))
    client = TestClient(app)
    assert client.get("/static/a.txt").text == "hello"
    assert client.head("/static/a.txt").status_code == 405


def test_declarative_redirect_and_trailing_slash_policy():
    app = SilloApp(trailing_slash="redirect")

    @app.get("/items")
    async def items(ctx: HttpContext):
        return []

    app.redirect("/u/{user_id}", "/users/{user_id}", status_code=301)
    client = TestClient(app, follow_redirects=False)
    r = client.get("/items/")
    assert r.status_code == 308 and r.headers["location"].endswith("/items")
    r = client.get("/u/7")
    assert r.status_code == 301 and r.headers["location"].endswith("/users/7")


def test_handler_keyword_registration_form():
    app = SilloApp()

    async def welcome(ctx: HttpContext):
        return {"hi": True}

    app.get("/", handler=welcome, name="welcome")
    assert TestClient(app).get("/").json() == {"hi": True}


def test_ctx_user_without_auth_middleware_raises():
    """ctx.user is not None or anonymous without AuthenticationMiddleware: it raises."""
    app = SilloApp()

    @app.get("/x")
    async def x(ctx: HttpContext):
        return {"user": str(ctx.user)}

    assert TestClient(app, raise_server_exceptions=False).get("/x").status_code == 500


def test_get_client_ip_trusts_forwarded_for_unconditionally():
    app = SilloApp()

    @app.get("/ip")
    async def ip(ctx: HttpContext):
        return {"ip": ctx.get_client_ip()}

    r = TestClient(app).get("/ip", headers={"x-forwarded-for": "6.6.6.6"})
    assert r.json() == {"ip": "6.6.6.6"}


def test_uploads_are_uploadedfile_in_a_dict_and_form_markers_bind():
    from sillo import File, Form

    app = SilloApp()

    @app.post("/up")
    async def up(ctx: HttpContext):
        files = await ctx.files
        form = await ctx.form
        f = files["doc"]
        return {"name": f.filename, "type": f.content_type, "size": len(await f.read()), "title": form.get("title")}

    @app.post("/marker")
    async def marker(ctx: HttpContext, doc=File(), title=Form("x")):
        return {"name": doc.filename, "title": title}

    client = TestClient(app)
    payload = {"files": {"doc": ("a.txt", b"hello", "text/plain")}, "data": {"title": "T"}}
    assert client.post("/up", **payload).json() == {"name": "a.txt", "type": "text/plain", "size": 5, "title": "T"}
    assert client.post("/marker", **payload).json() == {"name": "a.txt", "title": "T"}


def test_sse_encodes_dicts_and_named_events():
    from sillo import sse
    from sillo.http.sse import ServerSentEvent

    app = SilloApp()

    @app.get("/events")
    async def events(ctx: HttpContext):
        async def source():
            yield {"status": "paid"}
            yield ServerSentEvent(data="x", event="note", id="7")

        return sse(source(), keepalive=None)

    r = TestClient(app).get("/events")
    assert r.headers["content-type"].startswith("text/event-stream")
    assert 'data: {"status": "paid"}' in r.text
    assert "event: note" in r.text and "id: 7" in r.text


def test_ndjson_writes_one_document_per_line():
    from datetime import datetime

    from sillo import ndjson

    app = SilloApp()

    @app.get("/rows")
    async def rows(ctx: HttpContext):
        async def source():
            yield {"at": datetime(2026, 1, 1)}
            yield {"n": 2}

        return ndjson(source())

    lines = [line for line in TestClient(app).get("/rows").text.splitlines() if line]
    assert len(lines) == 2 and "2026-01-01" in lines[0]


def test_set_header_appends_unless_override():
    app = SilloApp()

    @app.get("/dup")
    async def dup(ctx: HttpContext):
        return json({}).set_header("X-Mode", "a").set_header("X-Mode", "b")

    @app.get("/replace")
    async def replace(ctx: HttpContext):
        return json({}).set_header("X-Mode", "a").set_header("X-Mode", "b", override=True)

    client = TestClient(app)
    assert client.get("/dup").headers.get_list("x-mode") == ["a", "b"]
    assert client.get("/replace").headers.get_list("x-mode") == ["b"]


def test_required_header_without_type_is_500_unless_strict():
    from sillo import Header

    def build(strict: bool) -> SilloApp:
        app = SilloApp(strict_validation=strict)

        @app.get("/untyped")
        async def untyped(ctx: HttpContext, key=Header(alias="X-API-Key", required=True)):
            return {"key": key}

        @app.get("/typed")
        async def typed(ctx: HttpContext, key=Header(alias="X-API-Key", type=str, required=True)):
            return {"key": key}

        return app

    lax = TestClient(build(False), raise_server_exceptions=False)
    assert lax.get("/untyped").status_code == 500
    assert lax.get("/typed").status_code == 422
    assert TestClient(build(True)).get("/untyped").status_code == 422


def test_body_and_query_422_shapes_differ():
    from pydantic import BaseModel

    class In(BaseModel):
        title: str

    app = SilloApp()

    @app.post("/b", request_model=In)
    async def body(ctx: HttpContext, payload):
        return {}

    @app.get("/q")
    async def query(ctx: HttpContext, limit=Query(10, type=int, le=100)):
        return {}

    client = TestClient(app)
    b = client.post("/b", json={}).json()
    q = client.get("/q?limit=500").json()
    assert isinstance(b, list) and b[0]["loc"] == ["title"]
    assert isinstance(q, dict) and q["detail"][0]["loc"] == ["query", "limit"]


def test_request_model_parses_json_even_for_form_posts():
    from pydantic import BaseModel

    class In(BaseModel):
        title: str

    app = SilloApp()

    @app.post("/f", request_model=In)
    async def f(ctx: HttpContext, payload):
        return {}

    assert TestClient(app).post("/f", data={"title": "x"}).status_code == 422


def test_app_decorators_return_none_router_decorators_return_the_function():
    """@app.get(...) returns None, so stacking app decorators fails; routers return the function."""
    app = SilloApp()

    @app.get("/a")
    async def on_app(ctx: HttpContext):
        return {}

    router = Router()

    @router.get("/b")
    async def on_router(ctx: HttpContext):
        return {}

    assert on_app is None
    assert callable(on_router)
    with pytest.raises(AssertionError):

        @app.get("/c")
        @app.post("/c")
        async def stacked(ctx: HttpContext):
            return {}


def test_body_model_errors_are_http_422_and_marker_errors_are_request_validation_error():
    from pydantic import BaseModel

    from sillo import RequestValidationError

    class In(BaseModel):
        title: str

    app = SilloApp()

    @app.add_exception_handler(RequestValidationError)
    async def marker_errors(ctx: HttpContext, exc):
        return json({"kind": "marker", "errors": exc.errors}, status_code=422)

    @app.add_exception_handler(422)
    async def status_422(ctx: HttpContext, exc):
        return json({"kind": "status", "errors": exc.detail}, status_code=422)

    async def body(ctx: HttpContext, payload):
        return {}

    async def query(ctx: HttpContext, limit=Query(10, type=int, le=100)):
        return {}

    app.post("/b", handler=body, request_model=In)
    app.get("/q", handler=query)
    client = TestClient(app)
    b = client.post("/b", json={}).json()
    q = client.get("/q?limit=500").json()
    assert b["kind"] == "status" and b["errors"][0]["loc"] == ["title"]
    assert q["kind"] == "marker" and q["errors"][0]["loc"] == ["query", "limit"]


def test_dependencies_are_not_cached_per_request():
    """The DI guide promises per-request caching; 1.0 calls the dependency every time."""
    calls: list[str] = []

    def get_db():
        calls.append("db")
        return object()

    def repo(db=Depend(get_db)):
        return db

    app = SilloApp()

    @app.get("/x")
    async def x(ctx: HttpContext, a=Depend(get_db), b=Depend(get_db), c=Depend(repo)):
        return {"same": a is b}

    assert TestClient(app).get("/x").json() == {"same": False}
    assert calls == ["db", "db", "db"]


def test_router_and_app_level_dependencies_run_for_every_route():
    ran: list[str] = []

    def audit(ctx):
        ran.append("audit")

    app = SilloApp(dependencies=[Depend(audit, get_context=True)])
    router = Router(prefix="/r", dependencies=[Depend(audit, get_context=True)])

    @router.get("/y")
    async def y(ctx: HttpContext):
        return {}

    app.mount_router(router)
    TestClient(app).get("/r/y")
    assert ran.count("audit") >= 1


def test_path_inside_mounted_router_is_relative_to_the_mount():
    app = SilloApp()
    router = Router(prefix="/r")

    @router.get("/y")
    async def y(ctx: HttpContext):
        return {"path": ctx.path, "root_path": ctx.scope.get("root_path")}

    app.mount_router(router)
    assert TestClient(app).get("/r/y").json() == {"path": "/y", "root_path": "/r"}


def test_dependency_raising_http_exception_short_circuits():
    from sillo.exceptions import HTTPException

    def need_key(key=Query(None, type=str)):
        if key != "k":
            raise HTTPException(401, "bad key")
        return key

    app = SilloApp()

    @app.get("/k")
    async def k(ctx: HttpContext, key=Depend(need_key)):
        return {"key": key}

    client = TestClient(app)
    assert client.get("/k").status_code == 401
    assert client.get("/k?key=k").json() == {"key": "k"}


def test_first_party_middleware_wiring():
    from sillo.http.etag import ETag
    from sillo.http.lifecycle import RequestId
    from sillo.middleware.gzip import GZipMiddleware
    from sillo.normalize import Normalize, SlashAction

    app = SilloApp()
    app.use(RequestId())
    app.use(ETag())
    app.use(Normalize(slash_action=SlashAction.REDIRECT_REMOVE))
    app.use(GZipMiddleware, minimum_size=10)

    @app.get("/big")
    async def big(ctx: HttpContext):
        return {"data": "x" * 2000}

    client = TestClient(app, follow_redirects=False)
    r = client.get("/big", headers={"accept-encoding": "gzip"})
    assert r.headers["x-request-id"] and r.headers["etag"]
    assert r.headers["content-encoding"] == "gzip"
    assert client.get("/big", headers={"if-none-match": r.headers["etag"]}).status_code == 304
    assert client.get("/big/").status_code == 301


def test_router_and_route_middleware_order():
    order: list[str] = []

    def mark(name):
        async def mw(ctx, call_next):
            order.append(name)
            return await call_next()

        return mw

    router = Router(prefix="/r", middleware=[mark("list-first"), mark("list-second")])
    router.use(mark("router-use"))

    @router.get("/x", middleware=[mark("route")])
    async def x(ctx: HttpContext):
        return {}

    app = SilloApp()
    app.use(mark("app"))
    app.mount_router(router)
    TestClient(app).get("/r/x")
    assert order == ["app", "router-use", "list-first", "list-second", "route"]


def test_error_body_shapes():
    from sillo import abort, not_found
    from sillo.exceptions import HTTPException

    app = SilloApp()

    @app.get("/string")
    async def string(ctx: HttpContext):
        raise HTTPException(404, "missing thing")

    @app.get("/dict")
    async def as_dict(ctx: HttpContext):
        abort(409, detail={"email": "taken"})

    @app.get("/nf")
    async def nf(ctx: HttpContext):
        not_found(detail="no such order")

    @app.get("/boom")
    async def boom(ctx: HttpContext):
        raise RuntimeError("secret internals")

    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/string").json() == "missing thing"
    assert client.get("/dict").json() == {"email": "taken"}
    generic = client.get("/nf").json()
    assert generic["status"] == 404 and "no such order" not in str(generic)
    assert client.get("/nope").json() == generic
    boom_r = client.get("/boom")
    assert boom_r.status_code == 500 and "secret internals" not in boom_r.text


def test_catch_all_and_status_handlers():
    async def server_error(ctx, exc):
        return json({"handled_by": "server_error_handler"}, status_code=500)

    app = SilloApp(server_error_handler=server_error)

    @app.add_exception_handler(404)
    async def not_found_handler(ctx: HttpContext, exc):
        return json({"handled_by": "404"}, status_code=404)

    @app.get("/boom")
    async def boom(ctx: HttpContext):
        raise RuntimeError("x")

    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/zzz").json() == {"handled_by": "404"}
    assert client.get("/boom").json() == {"handled_by": "server_error_handler"}

    app2 = SilloApp()

    @app2.add_exception_handler(Exception)
    async def catch_all(ctx: HttpContext, exc):
        return json({"handled_by": "Exception"}, status_code=500)

    @app2.get("/boom")
    async def boom2(ctx: HttpContext):
        raise RuntimeError("x")

    assert TestClient(app2, raise_server_exceptions=False).get("/boom").json() == {"handled_by": "Exception"}


def test_paginate_builder_shape_and_broken_links():
    """KNOWN BUG (1.0.0): paginate() appends '?page=…' to a URL that already has a query."""
    from sillo import paginate

    app = SilloApp()

    @app.get("/list")
    async def lst(ctx: HttpContext):
        return paginate(ctx, list(range(45)), strategy="page_number")

    body = TestClient(app).get("/list?page=2&page_size=10").json()
    assert body["items"] == list(range(10, 20))
    assert body["pagination"]["total_items"] == 45 and body["pagination"]["total_pages"] == 5
    assert body["pagination"]["links"]["next"].count("?") == 2


def test_openapi_document_docs_uis_and_auth_schemes():
    from pydantic import BaseModel

    from sillo.auth import JWTAuthBackend, useAuth
    from sillo.openapi.ui import Scalar
    from sillo.users import SimpleUser

    class Out(BaseModel):
        id: int

    app = SilloApp(title="Shop", version="2.0",
                   auth=[JWTAuthBackend(secret_key="x" * 40, identifier="sub")], auth_user_model=SimpleUser)
    items = Router(prefix="/items", tags=["items"])

    @items.get("/{item_id:int}", response_model=Out, summary="Get one", auth=useAuth(schemes=["bearerAuth"]))
    async def get_item(ctx: HttpContext, item_id: int, verbose=Query(False, type=bool)):
        return {"id": item_id}

    app.mount_router(items)
    client = TestClient(app)
    assert client.get("/docs").status_code == 200 and client.get("/redoc").status_code == 200
    spec = client.get("/openapi.json").json()
    op = spec["paths"]["/items/{item_id}"]["get"]
    assert op["tags"] == ["items"] and op["security"] == [{"bearerAuth": []}]
    assert {p["name"] for p in op["parameters"]} == {"item_id", "verbose"}
    assert "bearerAuth" in spec["components"]["securitySchemes"]
    assert "cdn.jsdelivr.net" in client.get("/docs").text

    custom = TestClient(SilloApp(docs=[Scalar(path="/reference")]))
    assert custom.get("/reference").status_code == 200 and custom.get("/docs").status_code == 404
    none = TestClient(SilloApp(docs=[]))
    assert none.get("/docs").status_code == 404 and none.get("/openapi.json").status_code == 200
