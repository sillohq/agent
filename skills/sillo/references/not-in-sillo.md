# Not in Sillo 1.x

Features developers ask for by name that Sillo does not provide. When a request needs
one, say so plainly and use the alternative — do not write `from sillo.locks import …`
or anything else that sounds as if it should exist.

This list is generated from the `absent` entries in the agent's capability inventory;
if you find something else missing, check the installed source before concluding it is.

## Distributed locks

There is no `sillo.locks` module or lock primitive. For "run this once across
processes", use Redis directly with `SET key value NX EX ttl` (redis-py:
`await redis.set(key, "1", nx=True, ex=ttl)`). A scheduled job's `max_instances` only
prevents overlapping runs inside one process; with several app processes each runs its
own scheduler.

## Metrics & tracing (OpenTelemetry)

Sillo ships request IDs (`sillo.http.lifecycle`) and logging, not metrics or tracing.
Add the OpenTelemetry ASGI middleware with `app.use(OpenTelemetryMiddleware, raw=True)`,
or time requests in your own middleware. Only `sillo_graphql` has an `opentelemetry`
hook of its own.

## Server-side HTML templating

The v0.x templating layer was removed in 1.0. Jinja2 is used only for email bodies
(`sillo-framework[mail]`). For pages use `sillo-inertia`; for a small HTML response
return `html(...)`; for full server-rendered templates keep your own
`jinja2.Environment` and return `html(template.render(...))`.

## Multi-channel notifications

There is no notification system. Compose one: `sillo.mail` for email, `sillo_wire`
rooms for in-app delivery, and a queued `Job` so sending never blocks the request.

## Translations & localization

`sillo.http.accepts` parses `Accept-Language`, but there are no translation catalogs or
gettext integration. Use Babel (or your own lookup) keyed on the negotiated language.

## Non-Redis queue brokers (SQS, RabbitMQ, Kafka)

Queue connections are `SyncConnection` (in-process, for tests) and `RedisConnection`.
For another broker, subclass `sillo.work.queue.QueueConnection` and implement `push`,
`pop`, `ack`, `fail`, `size` and `clear`.
