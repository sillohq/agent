"""Cache, events, mail, storage, WebSockets, the scheduler and background tasks."""

import asyncio

import pytest

from sillo import Depend, HttpContext, SilloApp, WebSocketContext
from sillo.testclient import TestClient


# ── cache ────────────────────────────────────────────────────────────────


async def test_cache_decorator_memoises_and_invalidates():
    from sillo.cache import MemoryCache, cache

    calls: list[int] = []
    backend = MemoryCache(default_ttl=60)

    @cache(backend=backend, ttl=60, tags=("products",))
    async def product(product_id: int):
        calls.append(product_id)
        return {"id": product_id}

    assert await product(1) == {"id": 1}
    assert await product(1) == {"id": 1}
    assert calls == [1]
    await backend.invalidate_tags("products")
    await product(1)
    assert calls == [1, 1]


async def test_cache_get_miss_is_a_sentinel_not_none():
    from sillo.cache import MemoryCache

    c = MemoryCache()
    missing = await c.get("nope")
    assert missing is not None
    assert await c.exists("nope") is False
    await c.set("k", None, ttl=10)
    assert await c.get("k") is None
    assert await c.exists("k") is True


# ── events ───────────────────────────────────────────────────────────────


async def test_app_events_emitter_on_and_emit_async():
    app = SilloApp()
    seen: list[dict] = []

    @app.events.on("user.created")
    async def handler(user):
        seen.append(user)

    await app.events.emit_async("user.created", {"name": "Bob"})
    assert seen == [{"name": "Bob"}]


async def test_work_event_dispatcher_and_listen_decorator_does_not_register():
    from dataclasses import dataclass

    from sillo.work.queue import Event, EventDispatcher, listen

    @dataclass
    class OrderShipped(Event):
        order_id: int

    dispatcher = EventDispatcher()
    seen: list[str] = []

    async def notify(event):
        seen.append(f"notify:{event.order_id}")

    @listen(OrderShipped)
    async def decorated_only(event):
        seen.append("decorated")

    dispatcher.register(OrderShipped, notify)
    await dispatcher.dispatch(OrderShipped(order_id=7))
    assert seen == ["notify:7"]


def test_setup_work_state_events_is_the_work_dispatcher_not_app_events():
    from sillo.work import setup_work
    from sillo.work.queue import EventDispatcher

    app = SilloApp()
    setup_work(app)
    assert isinstance(app.state["events"], EventDispatcher)
    assert type(app.events).__name__ == "EventEmitter"


# ── mail ─────────────────────────────────────────────────────────────────


def test_mail_suppress_send_returns_result_and_never_raises():
    from sillo.mail import MailConfig, get_mail_client, setup_mail

    app = SilloApp()
    setup_mail(app, MailConfig(suppress_send=True, default_from="app@example.com"))

    @app.post("/send")
    async def send(ctx: HttpContext):
        mail = get_mail_client(ctx)
        result = await mail.send_email(to="u@example.com", subject="Hi", body="Hello",
                                       html_body="<p>Hello</p>")
        return {"success": result.success, "provider": result.provider_response}

    with TestClient(app) as client:
        assert client.post("/send").json() == {"success": True, "provider": {"suppressed": True}}


async def test_mail_start_connects_eagerly_so_unreachable_smtp_fails_startup():
    """setup_mail registers client.start on startup; it connects unless suppress_send."""
    from sillo.mail import MailConfig, setup_mail

    app = SilloApp()
    setup_mail(app, MailConfig(smtp_host="127.0.0.1", smtp_port=1, default_from="a@b.c", smtp_timeout=1))
    with pytest.raises(OSError):
        await asyncio.wait_for(app._startup(), 10)


# ── storage ──────────────────────────────────────────────────────────────


def test_storage_local_bucket_put_get_stat_and_policy(tmp_path):
    from sillo.storage import BucketConfig, PolicyRefused, Private, StorageConfig, bucket, chunks, collect, setup_storage

    app = SilloApp()
    setup_storage(app, StorageConfig(
        default="files",
        secret="storage-secret-storage-secret",
        buckets={"files": BucketConfig(driver="local", root=str(tmp_path), policy=Private())},
    ))

    @app.post("/put")
    async def put(ctx: HttpContext):
        refused = False
        try:
            await bucket("files").put("x.txt", chunks(b"x"), content_type="text/plain")
        except PolicyRefused:
            refused = True  # Private() refuses unsigned operations, server code included
        stored = await bucket("files").put("reports/a.txt", chunks(b"hello"), content_type="text/plain", signed=True)
        info = await bucket("files").stat("reports/a.txt", signed=True)
        data = await collect(bucket("files").get("reports/a.txt", signed=True))
        url = bucket("files").signed_url("reports/a.txt", expires_in=60)
        return {"key": stored.key, "size": info.size, "data": data.decode(), "url": url, "refused": refused}

    with TestClient(app) as client:
        out = client.post("/put").json()
        assert out["refused"] is True
        assert out["key"] == "reports/a.txt" and out["size"] == 5 and out["data"] == "hello"
        assert (tmp_path / "reports" / "a.txt").read_bytes() == b"hello"
        served = client.get(out["url"])
        assert served.status_code == 200 and served.content == b"hello"
        assert client.get("/storage/files/reports/a.txt").status_code in (401, 403, 404)


def test_storage_rejects_unsafe_keys():
    from sillo.storage import UnsafeKey, normalise

    assert normalise("./a//b.txt") == "a/b.txt"
    with pytest.raises(UnsafeKey):
        normalise("../etc/passwd")


# ── websockets ───────────────────────────────────────────────────────────


def test_websocket_route_path_params_and_dependencies():
    app = SilloApp()

    def service():
        return "svc"

    @app.ws_route("/ws/room/{room_id}")
    async def room(ws: WebSocketContext, room_id: str, svc=Depend(service)):
        await ws.accept()
        await ws.send_json({"room": room_id, "svc": svc})
        message = await ws.receive_text()
        await ws.send_text(f"echo: {message}")
        await ws.close()

    with TestClient(app) as client:
        with client.websocket_connect("/ws/room/42") as ws:
            assert ws.receive_json() == {"room": "42", "svc": "svc"}
            ws.send_text("hi")
            assert ws.receive_text() == "echo: hi"


def test_no_app_websocket_decorator():
    assert not hasattr(SilloApp, "websocket")
    assert hasattr(SilloApp, "ws_route") and hasattr(SilloApp, "add_ws_route")


# ── scheduler & background ───────────────────────────────────────────────


async def test_scheduler_runs_interval_job():
    from sillo.work.scheduler import SchedulerManager

    s = SchedulerManager()
    ran: list[int] = []

    @s.every(1)
    async def tick():
        ran.append(1)

    await s.start()
    await asyncio.sleep(2.5)
    await s.stop()
    assert len(ran) >= 1


async def test_background_task_drain():
    from sillo.work.background import BackgroundTask

    done: list[int] = []

    async def slow():
        await asyncio.sleep(0.05)
        done.append(1)

    BackgroundTask.run(slow)
    summary = await BackgroundTask.drain(timeout=2)
    assert done == [1] and summary["completed"] >= 1


def test_testclient_hangs_when_a_startup_hook_raises(tmp_path):
    """KNOWN BUG (1.0.0): `with TestClient(app)` never returns if startup fails."""
    import subprocess
    import sys

    script = tmp_path / "hang.py"
    script.write_text(
        "from sillo import SilloApp\n"
        "from sillo.testclient import TestClient\n"
        "app = SilloApp()\n"
        "@app.on_startup\n"
        "async def boom():\n"
        "    raise RuntimeError('startup failed')\n"
        "with TestClient(app):\n"
        "    print('entered')\n"
    )
    with pytest.raises(subprocess.TimeoutExpired):
        subprocess.run([sys.executable, str(script)], capture_output=True, timeout=8,
                       env={**__import__("os").environ, "SILLO_ENV_FILE": ""})


def test_s3_driver_is_not_implemented_in_1_0_0():
    """KNOWN GAP (1.0.0): driver="s3" always raises; only local and memory drivers exist."""
    from sillo.storage import BucketConfig, StorageConfig, setup_storage

    app = SilloApp()
    with pytest.raises(ValueError, match="s3"):
        setup_storage(app, StorageConfig(default="b", secret="s" * 30, buckets={
            "b": BucketConfig(driver="s3", bucket="my-bucket", region="us-east-1",
                              access_key="AKIA", secret_key="x")}))


def test_custom_driver_bucket_can_be_added_to_storage():
    """The workaround for S3: build a Bucket around your own Driver and register it."""
    from sillo.storage import (Bucket, BucketConfig, MemoryDriver, Owned, StorageConfig, bucket, chunks,
                               collect, setup_storage)

    app = SilloApp()
    # Declare the name (bucket() checks the config), then swap in your own driver.
    storage = setup_storage(app, StorageConfig(default="uploads", secret="s" * 30,
                                               buckets={"uploads": BucketConfig(driver="memory")}))
    storage.buckets["uploads"] = Bucket("uploads", MemoryDriver(), policy=Owned())

    @app.post("/x")
    async def x(ctx: HttpContext):
        await bucket("uploads").put("a.txt", chunks(b"hi"), signed=True)
        return {"data": (await collect(bucket("uploads").get("a.txt", signed=True))).decode()}

    with TestClient(app) as client:
        assert client.post("/x").json() == {"data": "hi"}


def test_owned_policy_with_user_stream_upload_and_signed_put_gap(tmp_path):
    import inspect

    from sillo import File
    from sillo.storage import Bucket, BucketConfig, Owned, PolicyRefused, StorageConfig, bucket, setup_storage, stream_upload
    from sillo.users import SimpleUser

    assert "signed" not in inspect.signature(Bucket.page).parameters  # listing goes by policy + user only
    app = SilloApp()
    setup_storage(app, StorageConfig(default="avatars", secret="s" * 30, buckets={
        "avatars": BucketConfig(driver="local", root=str(tmp_path), policy=Owned())}))
    ada, bob = SimpleUser("ada"), SimpleUser("bob")

    @app.post("/upload")
    async def upload(ctx: HttpContext, avatar=File()):
        stored = await bucket("avatars").put(f"{ada.identity}/avatar", stream_upload(avatar),
                                             content_type=avatar.content_type or "", user=ada)
        refused = False
        try:
            await bucket("avatars").stat(stored.key, user=bob)
        except PolicyRefused:
            refused = True
        put_url = bucket("avatars").signed_url("ada/signed.txt", method="PUT", expires_in=60)
        return {"key": stored.key, "size": stored.size, "other_refused": refused, "put_url": put_url}

    with TestClient(app) as client:
        out = client.post("/upload", files={"avatar": ("a.png", b"\x89PNG\r\n\x1a\nxx", "image/png")}).json()
        assert out["key"] == "ada/avatar" and out["size"] == 10 and out["other_refused"] is True
        # KNOWN GAP (1.0.0): the built-in /storage route only serves GET, so signed
        # PUT URLs are minted but nothing accepts them.
        assert client.put(out["put_url"], content=b"via signed url").status_code == 405


async def test_http_client_returns_bodies_and_only_raises_when_configured():
    import httpx

    from sillo.http.client import HTTPClient, HTTPClientConfig, HTTPStatusError

    def handler(request):
        if request.url.path == "/missing":
            return httpx.Response(404, json={"error": "nope"})
        return httpx.Response(200, json={"id": 1})

    with pytest.raises(TypeError):
        bare = HTTPClient()
        await bare.start()

    results = {}
    for raise_for_status in (False, True):
        client = HTTPClient("https://api.test",
                            config=HTTPClientConfig(base_url="https://api.test", raise_for_status=raise_for_status))
        await client.start()
        client._state.client._transport = httpx.MockTransport(handler)
        try:
            assert await client.get("/items/1") == {"id": 1}
            results[raise_for_status] = await client.get("/missing")
        except HTTPStatusError as exc:
            results[raise_for_status] = exc.status_code
        finally:
            await client.stop()
    assert results == {False: {"error": "nope"}, True: 404}
