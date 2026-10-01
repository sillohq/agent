# @sillo/agent

Teach Claude Code, OpenCode and Codex the [Sillo](https://sillo.build) Python framework.

`sillo-agent` installs 39 version-aware Sillo skills into the coding agent you already use, so
it writes 1.x context-style handlers instead of inventing 0.x `(request, response)` code or
APIs Sillo deliberately does not have. It works offline and collects no telemetry.

```bash
npx github:sillohq/agent install claude
```

Then restart your agent and ask: "add Sillo auth to my project". Full guide below.

## Installation

Requires Node.js 20.12 or newer and at least one of Claude Code, OpenCode or Codex.

### 1. Install the skills

```bash
# straight from GitHub (no npm publish needed)
npx github:sillohq/agent install claude

# or, once published to npm
npx @sillo/agent install
```

Name the agents you want (`claude`, `opencode`, `codex`, any combination), or name none and
sillo-agent installs for every agent it finds.

To keep a permanent `sillo-agent` command:

```bash
npm install -g github:sillohq/agent     # or: npm install -g @sillo/agent
sillo-agent install
```

### 2. Choose where

| Command | Installs to | Use when |
|---|---|---|
| `sillo-agent install` (default `--global`) | `~/.claude/skills`, `~/.agents/skills`, ... | You want Sillo knowledge in every project |
| `sillo-agent install --project` | the project's own skill directories | You want teammates to get it by committing the files |

Preview first with `--dry-run`. A short Sillo block is added to `CLAUDE.md` / `AGENTS.md`;
skip it with `--no-instructions`.

### 3. Use it

Restart your coding agent (skills load at session start), open a Sillo project and ask for what
you want: "add Sillo auth to my project", "add sign in with Google", "paginate the products
endpoint". Check with `sillo-agent status` and `sillo-agent doctor`.

### Update and remove

```bash
npx github:sillohq/agent update      # or: sillo-agent update
sillo-agent uninstall                # removes only what it installed; edited files are kept
```

### From source

```bash
git clone https://github.com/sillohq/agent && cd agent
npm install && npm run check
node dist/cli/main.js install claude
```


## Commands

| | |
|---|---|
| `install [claude\|opencode\|codex …]` | Install skills and a short block in `CLAUDE.md` / `AGENTS.md` |
| `update` | Bring installed skills up to this version |
| `uninstall` | Remove only what sillo-agent installed; edited files are kept |
| `status` / `doctor` | What is installed, and whether it is intact |
| `info [dir]` | What sillo-agent detects about a project (Sillo version, packages) |
| `list`, `skills show <name>` | Browse skills as an agent receives them |
| `skills route "<request>"` | Which skills a request points to |
| `skills coverage` | Coverage of Sillo's capability inventory |

Flags: `--global` (default) · `--project` · `--dir` · `--dry-run` · `--force` ·
`--no-instructions` · `--with-package-skills` · `--json`.

Installs are tracked in a manifest (`.sillo-agent/manifest.json`), are idempotent, never overwrite
a file you edited without `--force` (a backup is kept), and refuse to write through symlinks.

## What the skills cover

The framework (application, routing, requests, responses, middleware, validation, record,
migrations, auth, sessions, users, security, cache, queues, scheduler, mail, storage, events,
websockets, OpenAPI, CLI, testing, debugging …) and the official packages: `sillo-inertia`,
`sillo-oauth`, `sillo-wire`, `sillo-graphql`, `warder` (admin), `sillo-start` (scaffolding).

Each skill follows one shape (When · Inspect first · How · Compose · Verify · Avoid), cites its
sources, and lists the public symbols it teaches. Guidance is rendered with version notes for the
Sillo release the project pins.

## Developing

```bash
npm install
npm run check     # typecheck, lint, skill validation, tests
npm run surface   # re-extract public API snapshots from installed packages
npm run probes    # run behaviour probes against real Sillo
npm run coverage:gaps
npm run eval:routing
npm run skill:new
```

`npm run validate` checks every skill's frontmatter, sections, listing budget, cross-references,
and that every referenced symbol exists in the framework surface snapshots in `framework/surface/`.

## Licence

BSD-3-Clause.
