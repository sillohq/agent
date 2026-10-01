---
name: sillo-helpers
title: Helpers (retry, threads, strings, network, files)
description: >-
  Sillo's utility helpers: retry, threadpool for blocking code, slugs and tokens, truncation, client IP and proxy checks, safe filenames, size parsing, HTML sanitising.
intents:
  - retry this flaky call with backoff
  - call this blocking library from an async handler
  - generate a slug from the title
  - generate a random token
  - sanitize user supplied HTML
  - make the uploaded filename safe
capabilities: [helpers]
related: [sillo-security, sillo-http-client, sillo-storage, sillo-requests]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.helpers.retry.retry
  - sillo.helpers.retry.async_retry
  - sillo.helpers.retry.RetryError
  - sillo.helpers.concurrency.run_in_threadpool
  - sillo.helpers.strings.slugify
  - sillo.helpers.strings.random_token
  - sillo.helpers.strings.mask_email
  - sillo.helpers.text.truncate
  - sillo.helpers.text.excerpt
  - sillo.helpers.network.get_client_ip
  - sillo.helpers.network.is_private_ip
  - sillo.helpers.files.safe_filename
  - sillo.helpers.files.parse_size
  - sillo.helpers.files.is_dangerous_extension
  - sillo.helpers.html.sanitize_html
  - sillo.helpers.html.escape_html
probes:
  - get_client_ip_trusts_forwarded_for_unconditionally
sources:
  - core:sillo/helpers/retry.py
  - core:sillo/helpers/concurrency.py
  - core:sillo/helpers/strings.py
  - core:sillo/helpers/network.py
  - core:sillo/helpers/files.py
  - core:sillo/helpers/html.py
  - docs:v1.0/guides/helpers/index.mdx
status: stable
---

## When

Before hand-writing a small utility: retries, threadpool offloading, slugs, tokens,
masking, truncation, IP checks, filenames, size strings, HTML escaping/sanitising.
Crypto, signing and JWT helpers are in `sillo-security` / `sillo-auth`.

## Inspect first

Whether the project already wraps any of these (a `utils.py`); keep using the project's
wrapper if one exists.

## How

```python
from sillo.helpers.concurrency import run_in_threadpool
from sillo.helpers.retry import RetryError, retry

@retry(max_attempts=4, base_delay=0.5, max_delay=10, retryable_exceptions=(ConnectionError, TimeoutError))
async def fetch_rates():
    return await rates_client.get("/latest")

pdf_bytes = await run_in_threadpool(render_pdf, invoice)     # blocking library, off the event loop
```

`retry(...)` decorates sync or async functions (exponential backoff, jitter); raises
`RetryError` when attempts run out. `async_retry(coro_fn, *args, ...)` retries a call
without decorating.

| Module | Useful functions |
|---|---|
| `sillo.helpers.strings` | `slugify`, `random_token(64)`, `random_string`, `random_digits(6)`, `mask_email`, `mask_string`, `camel_to_snake`, `snake_to_camel`, `kebab_case`, `strip_accents` |
| `sillo.helpers.text` | `truncate(text, 120)`, `excerpt(text, query)`, `pluralize(word, n)`, `word_count`, `strip_html`, `extract_urls`, `extract_emails` |
| `sillo.helpers.network` | `get_client_ip(headers, peer, trusted_proxies=[...])`, `is_private_ip`, `is_public_ip`, `subnet_contains`, `is_trusted_proxy` |
| `sillo.helpers.files` | `safe_filename`, `unique_filename`, `get_extension`, `is_dangerous_extension`, `is_image_extension`, `parse_size("10MB")`, `format_size`, `guess_mime_type`, `ensure_directory` |
| `sillo.helpers.html` | `escape_html`, `sanitize_html(html, allowed_tags=..., allowed_attrs=...)`, `strip_tags`, `linkify` |
| `sillo.helpers.hashing` | `constant_time_compare`, `digest`, `hmac_digest`, `hash_file` |

```python
from sillo.helpers.network import get_client_ip

ip = get_client_ip(ctx.headers, ctx.client.host if ctx.client else "",
                   trusted_proxies=["10.0.0.0/8"])   # forwarded headers honoured only from these
```

## Compose

Retrying HTTP calls — `sillo-http-client` has its own `RetryStrategy`; queue-level retries
— `sillo-queues` (`QRetryMiddleware`). Filenames for uploads — `sillo-storage`.

## Verify

Unit-test your function that uses the helper; for `run_in_threadpool`, assert the
handler stays responsive (no event-loop blocking) under a slow fake.

## Avoid

- `@retry(attempts=3, exceptions=(...))` (seen in some guides): the parameters are
  `max_attempts` and `retryable_exceptions`.
- Retrying non-idempotent calls (payments) without an idempotency key.
- Blocking calls (`requests`, heavy CPU, sync SDKs) directly in async handlers — use
  `run_in_threadpool` or a queued job.
- `ctx.get_client_ip()` for decisions — it trusts `X-Forwarded-For` from anyone.
