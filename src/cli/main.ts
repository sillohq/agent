#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AgentError } from "../core/errors.js";
import { AGENT_VERSION } from "../version.js";
import { devEval, devGaps, devNewSkill, devRender, devValidate } from "./commands/dev.js";
import { install, uninstall, update } from "./commands/install.js";
import { skillsCoverage, skillsList, skillsRoute, skillsShow } from "./commands/skills.js";
import { doctor, info, status } from "./commands/status.js";
import { Context, type Io } from "./context.js";

const HELP = `sillo-agent ${AGENT_VERSION}
Give Claude Code, OpenCode and Codex deep knowledge of the Sillo framework.

Usage
  sillo-agent install [claude|opencode|codex …]   Install Sillo skills (detects agents when none named)
  sillo-agent update                              Update installed skills to this version
  sillo-agent uninstall [agent …]                 Remove what sillo-agent installed
  sillo-agent status                              What is installed, where, and whether it is intact
  sillo-agent doctor                              Check the environment, project, agents and skills
  sillo-agent info [dir]                          Show what sillo-agent detects about a project
  sillo-agent list                                List the Sillo skills
  sillo-agent skills show <name>                  Print a skill as an agent would receive it
  sillo-agent skills coverage                     Coverage of Sillo's capability inventory
  sillo-agent skills route "<request>"            Which skills a request points to

Options
  --global            Install for your user (default for install)
  --project           Install into the current project, to commit and share
  --dir <path>        Treat <path> as the project directory
  --no-instructions   Skip the short Sillo block in CLAUDE.md / AGENTS.md
  --with-package-skills
                      Also install skills shipped by Python packages in the project's venv
  --dry-run           Show what would change without writing anything
  --force             Replace files you edited (a backup is kept)
  --json              Machine-readable output
  --no-color          Plain output
  -v, --version       Show the version
  -h, --help          Show this help

After installing, keep using your coding agent as usual:
  $ claude
  > add Sillo auth to my project

Nothing is sent anywhere: sillo-agent works offline and collects no telemetry.
`;

const DEV_HELP = `sillo-agent dev — maintainer commands (run from a sillohq/agent checkout)

  dev validate [--strict] [--core <sillo-core checkout>] [--skills-only]
  dev gaps [--surface <dir|file>] [--strict]
  dev eval [--k 5]
  dev render [--out .render] [--format claude|agents]
  dev new-skill <name> [--title "…"]
`;

export async function main(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        global: { type: "boolean" },
        project: { type: "boolean" },
        dir: { type: "string" },
        "no-instructions": { type: "boolean" },
        instructions: { type: "boolean" },
        "with-package-skills": { type: "boolean" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        json: { type: "boolean" },
        all: { type: "boolean" },
        raw: { type: "boolean" },
        format: { type: "string" },
        strict: { type: "boolean" },
        "skills-only": { type: "boolean" },
        core: { type: "string" },
        surface: { type: "string" },
        out: { type: "string" },
        title: { type: "string" },
        k: { type: "string" },
        "no-color": { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    io.stderr.write(
      `sillo-agent: ${(error as Error).message}\n\nRun sillo-agent --help for usage.\n`,
    );
    return 2;
  }
  const flags = parsed.values as Record<string, string | boolean | undefined>;
  const [command, ...rest] = parsed.positionals;
  const ctxOptions: { color?: boolean; quiet?: boolean } = {};
  if (flags["no-color"]) ctxOptions.color = false;
  const ctx = new Context(io, ctxOptions);

  if (flags.version) {
    io.stdout.write(`${AGENT_VERSION}\n`);
    return 0;
  }
  if (flags.help || !command || command === "help") {
    io.stdout.write(command === "dev" || rest[0] === "dev" ? DEV_HELP : HELP);
    return 0;
  }

  const common = {
    global: flags.global as boolean | undefined,
    project: flags.project as boolean | undefined,
    dir: flags.dir as string | undefined,
    json: flags.json as boolean | undefined,
  };
  const installFlags = {
    ...common,
    instructions: flags["no-instructions"] ? false : (flags.instructions as boolean | undefined),
    dryRun: flags["dry-run"] as boolean | undefined,
    force: flags.force as boolean | undefined,
    withPackageSkills: flags["with-package-skills"] as boolean | undefined,
  };

  try {
    switch (command) {
      case "install":
      case "add":
        return await install(ctx, rest, installFlags);
      case "update":
      case "upgrade":
        return await update(ctx, installFlags);
      case "uninstall":
      case "remove":
        return await uninstall(ctx, rest, installFlags);
      case "status":
        return await status(ctx, common);
      case "doctor":
        return await doctor(ctx, common);
      case "info":
        return await info(ctx, rest[0] ?? common.dir, common);
      case "list":
        return await skillsList(ctx, { json: common.json, all: flags.all as boolean | undefined });
      case "skills": {
        const [sub, ...args] = rest;
        switch (sub ?? "list") {
          case "list":
            return await skillsList(ctx, {
              json: common.json,
              all: flags.all as boolean | undefined,
            });
          case "show":
            return await skillsShow(ctx, args[0], {
              format: flags.format as string | undefined,
              raw: flags.raw as boolean | undefined,
            });
          case "coverage":
            return await skillsCoverage(ctx, common);
          case "route":
            return await skillsRoute(ctx, args, common);
          default:
            throw new AgentError(`Unknown skills command "${sub}".`, {
              hint: "list, show, coverage or route",
              exitCode: 2,
            });
        }
      }
      case "dev": {
        const [sub, ...args] = rest;
        switch (sub) {
          case "validate":
            return await devValidate(ctx, {
              skillsOnly: flags["skills-only"] as boolean,
              strict: flags.strict as boolean,
              core: flags.core as string,
              json: common.json,
            });
          case "gaps":
            return await devGaps(ctx, {
              surface: flags.surface as string,
              json: common.json,
              strict: flags.strict as boolean,
            });
          case "eval":
            return await devEval(ctx, { json: common.json, k: flags.k as string });
          case "render":
            return await devRender(ctx, {
              out: flags.out as string,
              format: flags.format as string,
            });
          case "new-skill":
            return await devNewSkill(ctx, args, { title: flags.title as string });
          default:
            io.stdout.write(DEV_HELP);
            return sub ? 2 : 0;
        }
      }
      case "version":
        io.stdout.write(`${AGENT_VERSION}\n`);
        return 0;
      default:
        throw new AgentError(`Unknown command "${command}".`, {
          hint: "Run sillo-agent --help.",
          exitCode: 2,
        });
    }
  } catch (error) {
    if (error instanceof AgentError) {
      ctx.err.fail(error.message);
      if (error.hint) ctx.err.muted(`    ${error.hint}`);
      return error.exitCode;
    }
    const e = error as Error;
    io.stderr.write(`sillo-agent: unexpected error: ${e.stack ?? e.message}\n`);
    io.stderr.write("Please report this at https://github.com/sillohq/agent/issues\n");
    return 70;
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const code = await main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  });
  process.exitCode = code;
}
