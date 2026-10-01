"""Record ORM: models, relations, scopes, casts, events, soft deletes, transactions."""

import pytest

pytest.importorskip("tortoise")

from sillo import HttpContext, SilloApp  # noqa: E402
from sillo.record import DatabaseConfig, setup_record  # noqa: E402
from sillo.testclient import TestClient  # noqa: E402


def _app(check):
    """Run `check()` inside a request so the per-request DB context is active."""
    app = SilloApp()
    setup_record(app, DatabaseConfig.sqlite(":memory:"), model_modules=["probe_record_models"])

    @app.get("/check")
    async def run(ctx: HttpContext):
        return await check()

    with TestClient(app) as client:
        r = client.get("/check")
        assert r.status_code == 200, r.text
        return r.json()


def test_model_has_timestamps_and_soft_delete_columns():
    from probe_record_models import Author, Post

    async def check():
        a = await Author.create(name="Ada")
        p = await Post.create(title="Hello World", author=a)
        await p.soft_delete()
        return {
            "created": p.created_at is not None,
            "deleted": p.deleted_at is not None,
            "all": await Post.all().count(),
            "active": await Post.active().count(),
            "slug": p.slug,
        }

    assert _app(check) == {"created": True, "deleted": True, "all": 1, "active": 0, "slug": "hello-world"}


def test_relations_need_fetching_and_select_related_loads_them():
    from probe_record_models import Author, Post, Tag

    async def check():
        a = await Author.create(name="Ada")
        p = await Post.create(title="One", author=a)
        t = await Tag.create(name="python")
        await p.tags.add(t)
        fresh = await Post.get(id=p.id)
        unfetched_is_loaded = not hasattr(fresh.author, "then") and hasattr(fresh.author, "name")
        joined = await Post.all().select_related("author").first()
        await fresh.fetch_related("tags")
        by_tag = await Post.filter(tags__name="python").count()
        return {
            "author_id": fresh.author_id == a.id,
            "unfetched_loaded": unfetched_is_loaded,
            "joined": joined.author.name,
            "tags": [x.name for x in fresh.tags],
            "by_tag": by_tag,
        }

    out = _app(check)
    assert out["author_id"] and out["joined"] == "Ada" and out["tags"] == ["python"] and out["by_tag"] == 1
    assert out["unfetched_loaded"] is False


def test_scopes_and_casts():
    from probe_record_models import Author, Post

    async def check():
        a = await Author.create(name="Ada")
        await Post.create(title="Draft", author=a)
        await Post.create(title="Live", author=a, status="published", meta={"theme": "dark"})
        live = await Post.published().by_author(a.id).first()
        again = await Post.get(id=live.id)
        return {"count": await Post.published().count(), "meta": again.meta}

    assert _app(check) == {"count": 1, "meta": {"theme": "dark"}}


def test_has_events_listeners_only_fire_when_fired_by_hand():
    """HasEvents/ModelObserver are a registry: nothing in Sillo 1.0 calls fire_event."""
    from probe_record_models import Author, Post

    seen: list[str] = []

    @Post.on("after_create")
    async def mark(post):
        seen.append(post.title)

    async def check():
        a = await Author.create(name="Ada")
        post = await Post.create(title="Auto", author=a)
        automatic = list(seen)
        await Post.fire_event("after_create", post)
        return {"automatic": automatic, "manual": list(seen)}

    assert _app(check) == {"automatic": [], "manual": ["Auto"]}


def test_tortoise_signals_fire_automatically():
    from tortoise.signals import post_delete, post_save

    from probe_record_models import Tag

    seen: list[tuple] = []

    @post_save(Tag)
    async def saved(sender, instance, created, using_db, update_fields):
        seen.append(("saved", created))

    @post_delete(Tag)
    async def deleted(sender, instance, using_db):
        seen.append(("deleted",))

    async def check():
        t = await Tag.create(name="signals")
        t.name = "signals2"
        await t.save()
        await t.delete()
        return {"seen": [list(x) for x in seen]}

    assert _app(check) == {"seen": [["saved", True], ["saved", False], ["deleted"]]}


@pytest.mark.filterwarnings("ignore::RuntimeWarning")
def test_update_from_dict_is_a_coroutine_and_update_or_create_update_path():
    from probe_record_models import Setting

    async def check():
        s = await Setting.create(key="theme", value="light")
        await s.update_from_dict({"value": "dark"})
        await s.save()
        saved = (await Setting.get(key="theme")).value
        created_ok = True
        try:
            await Setting.update_or_create(key="locale", defaults={"value": "en"})
        except Exception:
            created_ok = False
        update_ok = True
        try:
            await Setting.update_or_create(key="locale", defaults={"value": "fr"})
        except Exception:
            update_ok = False
        up = await Setting.upsert(key="locale", value="de", conflict_fields=["key"])
        return {"saved": saved, "created_ok": created_ok, "update_ok": update_ok, "upsert": up.value}

    out = _app(check)
    assert out["saved"] == "dark" and out["created_ok"] and out["upsert"] == "de"
    # Tortoise's update branch chains .save() onto Sillo's async
    # update_from_dict, so updating through update_or_create fails.
    assert out["update_ok"] is False


def test_record_paginate_is_not_the_response_paginate():
    import inspect

    import sillo
    from sillo.record import paginate as record_paginate

    assert "queryset" in inspect.signature(record_paginate).parameters
    assert "ctx" in inspect.signature(sillo.paginate).parameters

    from probe_record_models import Author

    async def check():
        for i in range(25):
            await Author.create(name=f"a{i}")
        page = await record_paginate(Author.all(), page=2, page_size=10, ordering="id")
        return {"items": len(page.items), "total": page.total, "pages": page.pages, "has_next": page.has_next}

    assert _app(check) == {"items": 10, "total": 25, "pages": 3, "has_next": True}


def test_transaction_rolls_back_on_error():
    from sillo.record.transactions import transaction

    from probe_record_models import Author

    async def check():
        try:
            async with transaction():
                await Author.create(name="kept?")
                raise RuntimeError("abort")
        except RuntimeError:
            pass
        return {"count": await Author.filter(name="kept?").count()}

    assert _app(check) == {"count": 0}


def test_to_dict_includes_timestamps():
    from probe_record_models import Author

    async def check():
        a = await Author.create(name="Ada")
        d = a.to_dict()
        return {"keys": sorted(d)}

    keys = _app(check)["keys"]
    assert {"id", "name", "created_at", "updated_at", "deleted_at"} <= set(keys)


def test_factory_create_and_make():
    from sillo.record.factories import Factory

    from probe_record_models import Author

    class AuthorFactory(Factory):
        model = Author
        definition = staticmethod(lambda: {"name": "Generated"})

    async def check():
        made = AuthorFactory.make()
        created = await AuthorFactory.create({"name": "Override"})
        many = await AuthorFactory.create_many(3)
        return {"made_saved": made.id is not None, "created": created.name, "many": len(many)}

    assert _app(check) == {"made_saved": False, "created": "Override", "many": 3}
