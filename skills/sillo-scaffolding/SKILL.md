---
name: sillo-scaffolding
title: Creating a new Sillo project
description: >-
  Start a new Sillo application with sillo-start: sillo-start create-app, the starter repository,
  options (--ref, --install, --no-git), generated secrets, and the next commands to run.
intents:
  - create a new Sillo project
  - scaffold an app from the starter
  - start a project from my own template repo
  - what do I run after creating the app
capabilities: [scaffolding]
related: [sillo-application, sillo-migrations, sillo-cli, sillo-users]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-start>=1.0"]
symbols: []
probes: []
sources:
  - pkg:start/README.md
  - docs:v1.0/start/index.md
status: stable
---

## When

An empty directory and a request for "a new Sillo app". Adding features to an existing project
is not this skill.

## Inspect first

- Whether the target directory exists and is empty (`--force` is needed otherwise).
- Python (3.11+ for the tool) and the package manager in use (`uv`, `pipx`, `pip`).
- Whether the user wants the default starter, a tag, or their own GitHub template.

## How

```bash
uvx sillo-start create-app myapp
cd myapp
uv sync
uv run sillo db:migrate
uv run sillo dev
```

Variants:

```bash
sillo-start create-app sillohq/starter myapp        # explicit
sillo-start create-app sillohq/starter@v1.2 myapp   # pinned tag
sillo-start create-app acme/our-template myapp      # any public GitHub repo
```

Options: `--ref <branch|tag>`, `-d/--directory`, `--install`, `--no-git`, `--force`, `-v`.

What it does: downloads the starter as a tarball (no git needed), renames the package and
title to the project name, writes `.env` from `.env.example` with fresh `SECRET_KEY`,
`JWT_SECRET`, `APP_KEY` (an existing `.env` is never touched), and runs `git init`.

What it does not do: migrations, users, queue workers, the server. Those are the project's own
`sillo` commands: `sillo db:migrate`, `sillo user:create ada@example.com --admin`,
`sillo queue:work`, `sillo dev`. The created project does not depend on `sillo-start`.

## Compose

After creation: migrations — `sillo-migrations`; first user — `sillo-users`; the `sillo`
command and its extensions — `sillo-cli`; deployment — `sillo-application`.

## Verify

`uv run sillo dev` boots and the home route answers; `uv run pytest` passes in the new project.

## Avoid

- Hand-writing a project skeleton when a starter exists: the starter is exercised in CI.
- Project names that are not valid Python identifiers (refused before anything is fetched).
- Committing the generated `.env`.
- Running `create-app` with `--force` into a directory with files you care about.
- Expecting `sillo-start` commands inside the created project: it only creates.
