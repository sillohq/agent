---
name: sillo-graphql
title: GraphQL APIs
description: >-
  GraphQL on Sillo with sillo-graphql and Strawberry: Graph(...).mount, ctx-first @field resolvers with
  Depend, Limits and cost, masked errors, loaders, subscriptions, persisted operations, GraphClient tests.
intents:
  - add a GraphQL endpoint
  - write a resolver that uses the database dependency
  - stop expensive or deeply nested queries
  - fix N+1 queries in a GraphQL resolver
  - add a GraphQL subscription
  - migrate from sillo.graphql
capabilities: [graphql]
related: [sillo-dependency-injection, sillo-auth, sillo-websockets, sillo-testing]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-graphql>=1.0", "strawberry-graphql"]
symbols:
  - sillo_graphql.Graph
  - sillo_graphql.field
  - sillo_graphql.mutation
  - sillo_graphql.subscription
  - sillo_graphql.loader
  - sillo_graphql.Limits
  - sillo_graphql.ErrorPolicy
  - sillo_graphql.Transport
  - sillo_graphql.Uploads
  - sillo_graphql.Persisted
  - sillo_graphql.OperationLog
  - sillo_graphql.Metrics
  - sillo_graphql.not_found
  - sillo_graphql.forbidden
  - sillo_graphql.unauthenticated
  - sillo_graphql.testing.GraphClient
probes: []
sources:
  - pkg:sillo-graphql/README.md
  - pkg:sillo-graphql/sillo_graphql
  - docs:packages/graphql/index.md
status: stable
---

## When

A GraphQL API on Sillo. Strawberry owns the schema; `sillo-graphql` owns transports, safety
and observability. REST/JSON routes stay `sillo-routing`.

## Inspect first

- Whether the project uses the old framework `sillo.graphql` (`GraphQL(app, schema, ...)`,
  `info.context["ctx"]`): that is the migration path below.
- The existing `Depend` providers (database sessions) and the auth scheme to gate the route.

## How

```python
import strawberry
from sillo import Depend, HttpContext, SilloApp
from sillo_graphql import Graph, Limits, field

@strawberry.type
class Query:
    @field
    async def posts(ctx: HttpContext, db=Depend(get_db, get_context=True), limit: int = 10) -> list[Post]:
        return await db.posts.recent(limit)

app = SilloApp()
Graph(strawberry.Schema(query=Query), limits=Limits(depth=8)).mount(app)
```

**Resolver rule**: `ctx` and anything defaulted to `Depend(...)` are injected and never appear
in the schema; every other parameter is a GraphQL argument (above: only `limit`). No `self`,
no `info`. Siblings asking for the same `Depend(get_db, get_context=True)` share one session.

**Config** (defaults suit a public endpoint: IDE off, introspection off, errors masked):

```python
Graph(schema, path="/graphql", ide=False, introspection=False, subscriptions=True,
      auth=Bearer(), limits=Limits(depth=10, cost=1_000, aliases=15),
      errors=ErrorPolicy(mask=True), transport=Transport(get_queries=True, batch=10),
      uploads=Uploads(enabled=True, max_size="10MB"),
      persisted=Persisted(apq=True, trusted="operations.json")).mount(app)
```

- **Cost**: refused before any resolver runs with `OPERATION_TOO_COMPLEX`; `@field(cost=25)`
  weights an expensive field; lists multiply by the requested page size.
- **Errors**: `raise not_found("...")`, `forbidden`, `unauthenticated`, `bad_input`, `conflict`
  reach the client with `extensions.code`; any other exception is masked and logged. Map your
  own with `@graph.on_error(RecordNotFound)`.
- **N+1**: `@graph.loader` takes `keys: list` and returns values aligned to keys; call
  `await load_author(post.author_id)` from sibling fields (per-operation cache).
- **Subscriptions**: `graphql-transport-ws` (and SSE with `sse=True`). Authenticate in
  `@graph.on_connect` (browsers cannot set WebSocket headers).
- **Observability**: `graph.on_operation(OperationLog(slower_than=0.5))`, `Metrics()`.
- **Trusted documents**: `Persisted(trusted="operations.json")` executes nothing else.

## Compose

`Depend` providers — `sillo-dependency-injection`; route gate via `auth=` — `sillo-auth`;
records — `sillo-record`; the subscription socket — `sillo-websockets`.

## Verify

```python
from sillo_graphql.testing import GraphClient

with GraphClient(app) as gql:
    result = gql.query("{ me { email } }")
    assert result.ok and result["me"]["email"] == "a@b.c"
```

Subscriptions: `async with GraphClient(app).subscribe(QUERY, symbol="ACME") as stream:
await stream.next()`.

## Avoid

- `info.context["ctx"]` and `self`/`info` resolvers in new code: take `ctx` first.
- Turning on `ide=True` / `introspection=True` in production.
- Raising bare exceptions to signal client errors (they are masked as `INTERNAL_SERVER_ERROR`).
- Querying per node inside a resolver instead of a `@graph.loader`.
- Shipping without `Limits` on a public endpoint.
