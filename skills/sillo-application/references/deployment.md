# Running and deploying a Sillo application

## Local development

```bash
sillo dev                         # finds the app, reloads on change
sillo dev app.main:app --port 9000
sillo dev --no-reload
```

`sillo dev` loads `.env` before importing the application, watches the project for
Python changes, and prints Sillo's compact request log.

## Production process

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

Run it under systemd, a container orchestrator or another supervisor, behind a reverse
proxy (nginx, Caddy). `granian` is supported through the `sillo-framework[granian]` extra
if you prefer it. `sillo dev` and `uvicorn --reload` are development servers.

Settings that matter in production:

- `SilloApp(debug=False)` — the default. Never enable it on a public server.
- Secrets from the environment, not a `.env` baked into an image. Exported variables
  win over `.env` anyway.
- `force_https=True` when TLS terminates at the proxy and plain-http requests should be
  redirected; the proxy must set `X-Forwarded-Proto`.
- `root_path="/prefix"` when the proxy serves the app under a sub-path.
- `DB_GENERATE_SCHEMAS=false` (or `DatabaseConfig(generate_schemas=False)`) once the
  project uses migrations.

## Migrations are a release step

```bash
uv run sillo db:migrate && exec uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Or a one-off job/init container that runs `sillo db:migrate` before the new version
starts. Never migrate from a startup hook: every replica and worker would run it.

## Reverse proxy

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location /static/ { alias /srv/app/static/; expires 30d; }
```

The proxy must **replace** client-supplied forwarding headers: `ctx.get_client_ip()` trusts
`X-Forwarded-For` unconditionally.

## Container

```dockerfile
FROM python:3.12-slim
RUN pip install uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY . .
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Run migrations as a separate container command: `["uv", "run", "sillo", "db:migrate"]`.

## Background processes

Queue workers and the scheduler are separate processes in production
(`sillo queue:work`, `sillo schedule:run`) with `QUEUE_URL` pointing at Redis — see the
`sillo-queues` and `sillo-scheduler` skills. The in-process defaults lose work on
restart.

## Health checks

Liveness should check nothing external; readiness can check the database:

```python
from sillo import HttpContext, json

@app.get("/healthz")
async def liveness(ctx: HttpContext):
    return {"status": "ok"}

@app.get("/readyz")
async def readiness(ctx: HttpContext):
    ok = await ctx.app.state["record"].health()
    return json({"database": ok}, status_code=200 if ok else 503)
```

## Checklist

- `debug` off; secrets from the environment.
- Migrations run once per release, not per process.
- More than one worker ⇒ not SQLite; sessions and caches not in process memory.
- Queue worker and scheduler running as their own processes with Redis.
- Static files served by the proxy.
- The proxy sets `X-Forwarded-Proto` and overwrites `X-Forwarded-For`.
