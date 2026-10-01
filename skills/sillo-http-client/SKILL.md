---
name: sillo-http-client
title: Outbound HTTP client
description: >-
  Calling external APIs from Sillo with sillo.http.client.HTTPClient: base URL and config,
  starting and stopping it with the app, raise_for_status, response models, retries,
  timeouts, caching and client middleware.
intents:
  - call an external API from the app
  - integrate the payment provider's REST API
  - retry the request if the upstream fails
  - parse the API response into a model
  - add a timeout to outgoing requests
capabilities: [http_client]
related: [sillo-application, sillo-queues, sillo-helpers, sillo-cache]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework", "httpx"]
symbols:
  - sillo.http.client.HTTPClient
  - sillo.http.client.HTTPClientConfig
  - sillo.http.client.RetryStrategy
  - sillo.http.client.HTTPStatusError
  - sillo.http.client.HTTPClientError
  - sillo.http.client.HTTPClient.start
  - sillo.http.client.HTTPClient.stop
  - sillo.http.client.HTTPClient.get
  - sillo.http.client.HTTPClient.post
probes:
  - http_client_returns_bodies_and_only_raises_when_configured
sources:
  - core:sillo/http/client/client.py
  - core:sillo/http/client/config.py
  - core:sillo/http/client/retry.py
  - docs:v1.0/guides/http/client.md
status: stable
---

## When

The app calls another HTTP service: payment providers, webhooks out, partner APIs,
internal microservices. Slow or unreliable calls triggered by user actions should also
go through `sillo-queues`.

## Inspect first

Existing API client wrappers, where credentials come from (settings/env), and whether
the call happens in a request, a job or a scheduled task.

## How

One client per upstream, created at startup and closed at shutdown:

```python
from sillo.http.client import HTTPClient, HTTPClientConfig, RetryStrategy

payments = HTTPClient(
    settings.payments_base_url,
    config=HTTPClientConfig(
        base_url=settings.payments_base_url,
        default_timeout=10.0,
        default_headers={"Authorization": f"Bearer {settings.payments_key}"},
        raise_for_status=True,                    # otherwise error bodies come back as data
        retry_strategy=RetryStrategy(max_attempts=3, base_delay=0.5),
    ),
)

@app.on_startup
async def start_clients():
    await payments.start()
    app.state["myapp.payments"] = payments

@app.on_shutdown
async def stop_clients():
    await payments.stop()
```

Calls return the **parsed body** (JSON → dict/list, otherwise text), or a validated model:

```python
from pydantic import BaseModel
from sillo.http.client import HTTPStatusError

class Charge(BaseModel):
    id: str
    status: str

try:
    charge = await payments.post("/charges", json={"amount": 1999}, response_model=Charge)
except HTTPStatusError as exc:
    logger.warning("charge failed: %s", exc.status_code)
    raise
```

`get/post/put/patch/delete/head/options(url, **httpx_kwargs, response_model=, many=)`;
`request(method, url, ...)`. Also: response caching (`cache_backend`, `cache_ttl`),
client middleware (`BaseURLMiddleware`, `HeaderInjectionMiddleware`, `LoggingMiddleware`),
`stats()`. Retries apply to retryable statuses and connection errors.

## Compose

Start/stop with the app — `sillo-application`; call from jobs for durability —
`sillo-queues`; cache upstream responses — `sillo-cache`; generic retry decorator —
`sillo-helpers`.

## Verify

In tests, swap the client with a fake through a dependency override, or use an httpx
`MockTransport`; assert both the success path and a 4xx/5xx path.

## Avoid

- `HTTPClient()` with no base URL: `start()` fails with "Invalid type for url" in 1.0.0.
  Pass a base URL (use absolute URLs per call if the client talks to several hosts).
- Leaving `raise_for_status` at its default `False`: a 404's JSON error body is returned
  as if it were the resource.
- Creating a client per request (connection pools are expensive) or never calling
  `stop()`.
- Calling slow third parties inline in user-facing handlers without a timeout.
