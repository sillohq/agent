---
name: sillo-cache
title: Caching
description: >-
  Caching in Sillo with sillo.cache: the @cache decorator with TTLs, tags and namespaces,
  configure_cache with MemoryCache or RedisCache, direct get/set, invalidation, and HTTP
  cache headers.
intents:
  - cache this for 10 minutes
  - cache this expensive query
  - add Redis caching to this
  - invalidate the cache when a product changes
  - cache the response
capabilities: [cache]
related: [sillo-record, sillo-responses, sillo-middleware, sillo-rate-limiting]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework", "sillo-framework[cache] for Redis"]
symbols:
  - sillo.cache.cache
  - sillo.cache.configure_cache
  - sillo.cache.MemoryCache
  - sillo.cache.RedisCache
  - sillo.cache.BaseCache.get
  - sillo.cache.BaseCache.set
  - sillo.cache.BaseCache.invalidate_tags
  - sillo.cache.BaseCache.exists
probes:
  - cache_decorator_memoises_and_invalidates
  - cache_get_miss_is_a_sentinel_not_none
sources:
  - core:sillo/cache/decorator.py
  - core:sillo/cache/backends.py
  - core:sillo/cache/base.py
  - core:sillo/cache/config.py
  - docs:v1.0/guides/cache.mdx
status: stable
---

## When

Avoiding repeated expensive work: slow queries, third-party API calls, computed
aggregates. Browser/CDN caching of responses is `Cache-Control` / ETags (see How).

## Inspect first

Existing `configure_cache(...)` calls, whether Redis is available (`REDIS_URL`), how
many processes serve the app (in-memory caches are per process), and what writes must
invalidate the cached value.

## How

Configure a default backend once, at import/startup:

```python
from sillo.cache import MemoryCache, RedisCache, configure_cache

configure_cache(RedisCache(url=settings.redis_url, namespace="shop", default_ttl=300)
                if settings.redis_url else MemoryCache(default_ttl=300))
```

**Cache a function** (sync or async); arguments form the key:

```python
from sillo.cache import cache

@cache(ttl=600, tags=("products",))               # 10 minutes
async def top_products(category_id: int) -> list[dict]:
    rows = await Product.filter(category_id=category_id).order_by("-sales").limit(10)
    return [p.to_dict() for p in rows]
```

Return plain data (dicts/lists) — the default JSON serializer does not store model
instances. Options: `namespace=`, `version=` (bump to invalidate everything),
`key_prefix=`, `sliding=True`, `skip_cache_if=lambda *a, **k: ...`, `backend=`.

**Invalidate** on writes:

```python
from sillo.cache import get_default_backend

await get_default_backend().invalidate_tags("products")      # after a product changes
```

**Direct use:**

```python
store = get_default_backend()
await store.set("rates:usd", rates, ttl=60, tags=["rates"])
if await store.exists("rates:usd"):
    rates = await store.get("rates:usd")
await store.delete("rates:usd")
```

A miss returns a sentinel object, not `None` — check with `exists()` (or compare with the
sentinel) rather than `if value is None`.

**HTTP caching** is separate: `json(data).cache(max_age=60, private=False)` sets
`Cache-Control`; `app.use(ETag())` answers conditional requests with 304
(`sillo-middleware`).

## Compose

Invalidate from write paths or model signals — `sillo-record`. Rate limiting has its own
Redis backend — `sillo-rate-limiting`. Response headers — `sillo-responses`.

## Verify

A test calling the cached function twice and asserting the underlying call ran once; then
invalidate and assert it runs again. With Redis, check keys under your namespace.

## Avoid

- `MemoryCache` with several processes when correctness depends on invalidation — each
  process has its own copy. Use Redis.
- Caching per-user data under a key that does not include the user.
- `if await store.get(k) is None:` to detect a miss.
- Caching ORM model instances with the JSON serializer; cache `to_dict()` output.
- `Shield()` adds `Cache-Control: no-store` to every response (`sillo-security`); set its
  `cache_control` if you rely on HTTP caching.
