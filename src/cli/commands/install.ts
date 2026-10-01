import path from "node:path";
import { AgentError } from "../../core/errors.js";
import { displayPath } from "../../core/paths.js";
import { HOSTS, parseHost } from "../../hosts/index.js";
import { HOST_IDS, type HostId, type Scope } from "../../hosts/types.js";
import { readManifest } from "../../install/manifest.js";
import { buildPlan, type Plan } from "../../install/plan.js";
import { type Change, type ReconcileResult, reconcile } from "../../install/reconcile.js";
import { loadPackageSkills } from "../../skills/packages.js";
import type { Skill } from "../../skills/schema.js";
import { AGENT_VERSION } from "../../version.js";
import { type Context, loadCatalog, scopeFromFlags } from "../context.js";

export interface InstallFlags {
  global?: boolean;
  project?: boolean;
  dir?: string;
  instructions?: boolean;
  dryRun?: boolean;
  force?: boolean;
  withPackageSkills?: boolean;
  json?: boolean;
}

async function detectHosts(
  ctx: Context,
): Promise<Array<{ id: HostId; found: boolean; evidence: string[] }>> {
  const out = [];
  for (const id of HOST_IDS) out.push({ id, ...(await HOSTS[id].detect(ctx.envr)) });
  return out;
}

async function skillsFor(
  ctx: Context,
  scope: Scope,
  withPackages: boolean,
  projectRoot: string,
): Promise<Skill[]> {
  const catalog = await loadCatalog();
  const skills = catalog.skills.filter((s) => s.meta.status !== "draft");
  if (!withPackages) return skills;
  if (scope !== "project") {
    throw new AgentError("--with-package-skills only applies to a project install.", {
      hint: "Package skills come from the project's own virtual environment. Add --project.",
      exitCode: 2,
    });
  }
  const { skills: extra, problems } = await loadPackageSkills(
    projectRoot,
    new Set(skills.map((s) => s.meta.name)),
  );
  for (const p of problems) ctx.err.warn(p);
  for (const s of extra) {
    ctx.ui.info(
      `package skill ${s.meta.name}`,
      s.origin.kind === "package" ? `from ${s.origin.distribution}` : "",
    );
  }
  return [...skills, ...extra];
}

async function apply(
  ctx: Context,
  scope: Scope,
  hosts: HostId[],
  flags: InstallFlags,
  instructions: boolean,
): Promise<{ plan: Plan; result: ReconcileResult }> {
  const hctx = await ctx.hostContext(flags.dir);
  const catalog = await loadCatalog();
  const skills = hosts.length
    ? await skillsFor(ctx, scope, Boolean(flags.withPackageSkills), hctx.projectRoot)
    : [];
  const plan = buildPlan({
    scope,
    hosts,
    ctx: hctx,
    skills,
    versions: catalog.versions,
    instructions,
  });
  const options: { force?: boolean; dryRun?: boolean } = {};
  if (flags.force) options.force = true;
  if (flags.dryRun) options.dryRun = true;
  const result = await reconcile(plan, hctx, options);
  return { plan, result };
}

function tally(changes: Change[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) out[c.action] = (out[c.action] ?? 0) + 1;
  return out;
}

function reportProblems(ctx: Context, result: ReconcileResult): number {
  let problems = 0;
  if (result.quarantined) {
    ctx.ui.warn(
      `The manifest was unreadable (${result.quarantined.reason}).`,
      `moved to ${displayPath(result.quarantined.path, ctx.envr)}; ownership rebuilt from generated files`,
    );
  }
  for (const c of result.changes) {
    const where = displayPath(c.path, ctx.envr);
    if (c.action === "conflict") {
      problems++;
      ctx.ui.fail(where, c.note);
    } else if (c.action === "kept-modified" || c.action === "left-modified") {
      ctx.ui.warn(where, c.note);
    } else if (c.action === "refused") {
      problems++;
      ctx.ui.fail(`refused ${where}`, c.note);
    } else if (c.action === "skipped" && c.note) {
      ctx.ui.skip(where, c.note);
    }
  }
  for (const b of result.backups) ctx.ui.muted(`    backup: ${displayPath(b, ctx.envr)}`);
  return problems;
}

function describeLocations(ctx: Context, plan: Plan): void {
  for (const { location, hosts } of plan.locations) {
    const names = hosts.map((h) => HOSTS[h].name).join(" + ");
    const count = new Set(
      plan.files.filter((f) => f.locationDir === location.dir).map((f) => f.skill),
    ).size;
    ctx.ui.ok(names.padEnd(22), `${count} skills → ${displayPath(location.dir, ctx.envr)}`);
  }
  for (const block of plan.blocks) {
    ctx.ui.ok("Instructions".padEnd(22), displayPath(block.abs, ctx.envr));
  }
}

export async function install(
  ctx: Context,
  requested: string[],
  flags: InstallFlags,
): Promise<number> {
  const scope: Scope = scopeFromFlags(flags) ?? "global";
  const hctx = await ctx.hostContext(flags.dir);
  if (scope === "project" && path.resolve(hctx.projectRoot) === path.resolve(ctx.envr.home)) {
    throw new AgentError("Refusing a project install into your home directory.", {
      hint: "Run it inside the project, or use --global.",
      exitCode: 2,
    });
  }
  const ui = ctx.ui;
  ui.heading(`Sillo Agent ${AGENT_VERSION}`);

  const detected = await detectHosts(ctx);
  let hosts: HostId[];
  if (requested.length) {
    hosts = [...new Set(requested.map(parseHost))];
  } else {
    ui.section("Coding agents");
    for (const d of detected) {
      if (d.found) ui.ok(HOSTS[d.id].name.padEnd(12), d.evidence[0]);
      else ui.skip(HOSTS[d.id].name.padEnd(12), "not found");
    }
    hosts = detected.filter((d) => d.found).map((d) => d.id);
    if (!hosts.length) {
      throw new AgentError("No supported coding agent was found.", {
        hint: "Install Claude Code, OpenCode or Codex, or name one explicitly: sillo-agent install claude",
      });
    }
  }

  // Installing adds to what is already there; it never drops a host.
  const existing = await readManifest(scope === "global" ? ctx.envr.home : hctx.projectRoot);
  let instructions = flags.instructions ?? true;
  if (existing.state === "ok") {
    hosts = [...new Set([...existing.manifest.hosts, ...hosts])];
    if (flags.instructions === undefined) instructions = existing.manifest.options.instructions;
  }

  ui.section(`Installing Sillo intelligence (${scope}${flags.dryRun ? ", dry run" : ""})`);
  const { plan, result } = await apply(ctx, scope, hosts, flags, instructions);
  describeLocations(ctx, plan);

  const catalog = await loadCatalog();
  const titles = catalog.skills
    .filter((s) => s.meta.status === "stable")
    .map((s) => (s.meta.name === "sillo" ? "Core" : s.meta.title.split(/ [(—-] /)[0]!));
  ui.line();
  ui.line(wrap(titles.join(" · "), 76, "    ", ui));

  const problems = reportProblems(ctx, result);
  const counts = tally(result.changes);
  ui.line();
  ui.muted(
    `  ${counts.created ?? 0} created, ${counts.updated ?? 0} updated, ${(counts.unchanged ?? 0) + (counts.adopted ?? 0)} unchanged` +
      (counts.removed ? `, ${counts.removed} removed` : "") +
      (problems ? `, ${problems} need attention` : ""),
  );

  if (flags.json) {
    ctx.io.stdout.write(`${JSON.stringify({ scope, hosts, changes: result.changes }, null, 2)}\n`);
  }
  if (flags.dryRun) {
    ui.line();
    ui.line("Dry run: nothing was written.");
    return problems ? 1 : 0;
  }
  ui.line();
  ui.line(ui.paint("bold", "Sillo support installed."));
  const first = hosts.includes("claude")
    ? "claude"
    : hosts.includes("opencode")
      ? "opencode"
      : "codex";
  ui.line("Open your coding agent and start building:");
  ui.line();
  ui.line(`  ${ui.paint("gray", "$")} ${first}`);
  ui.line(`  ${ui.paint("gray", ">")} add Sillo auth to my project`);
  if (scope === "project") {
    ui.line();
    ui.muted(
      "Commit the skill directories to share them with your team, or add them to .gitignore.",
    );
  }
  return problems ? 1 : 0;
}

export async function update(ctx: Context, flags: InstallFlags): Promise<number> {
  const scopes = scopeFromFlags(flags)
    ? [scopeFromFlags(flags)!]
    : await ctx.installedScopes(flags.dir);
  if (!scopes.length) {
    throw new AgentError("Sillo Agent is not installed here or globally.", {
      hint: "Run: sillo-agent install",
    });
  }
  ctx.ui.heading(`Sillo Agent ${AGENT_VERSION} — update`);
  let failures = 0;
  for (const scope of scopes) {
    const hctx = await ctx.hostContext(flags.dir);
    const read = await readManifest(scope === "global" ? ctx.envr.home : hctx.projectRoot);
    const hosts = read.state === "ok" ? read.manifest.hosts : [];
    if (!hosts.length && read.state !== "corrupt") continue;
    const instructions =
      flags.instructions ?? (read.state === "ok" ? read.manifest.options.instructions : true);
    const withPackages =
      flags.withPackageSkills ??
      (read.state === "ok" ? read.manifest.options.packageSkills : false);
    ctx.ui.section(
      `${scope === "global" ? "Global" : "Project"} (${hosts.map((h) => HOSTS[h].name).join(", ") || "recovering"})`,
    );
    const { result } = await apply(
      ctx,
      scope,
      hosts,
      { ...flags, withPackageSkills: withPackages },
      instructions,
    );
    const counts = tally(result.changes);
    failures += reportProblems(ctx, result);
    ctx.ui.ok(
      `${counts.updated ?? 0} updated, ${counts.created ?? 0} added, ${counts.removed ?? 0} removed, ${(counts.unchanged ?? 0) + (counts.adopted ?? 0)} unchanged`,
    );
  }
  return failures ? 1 : 0;
}

export async function uninstall(
  ctx: Context,
  requested: string[],
  flags: InstallFlags,
): Promise<number> {
  const scopes = scopeFromFlags(flags)
    ? [scopeFromFlags(flags)!]
    : await ctx.installedScopes(flags.dir);
  if (!scopes.length) {
    ctx.ui.line("Nothing to uninstall: no Sillo Agent installation was found here or globally.");
    return 0;
  }
  const drop = new Set(requested.map(parseHost));
  ctx.ui.heading(`Sillo Agent ${AGENT_VERSION} — uninstall`);
  let failures = 0;
  for (const scope of scopes) {
    const hctx = await ctx.hostContext(flags.dir);
    const read = await readManifest(scope === "global" ? ctx.envr.home : hctx.projectRoot);
    const current = read.state === "ok" ? read.manifest.hosts : [];
    const remaining = drop.size ? current.filter((h) => !drop.has(h)) : [];
    const instructions = read.state === "ok" ? read.manifest.options.instructions : true;
    ctx.ui.section(scope === "global" ? "Global" : "Project");
    const { result } = await apply(
      ctx,
      scope,
      remaining,
      flags,
      instructions && remaining.length > 0,
    );
    failures += reportProblems(ctx, result);
    const removed = result.changes.filter((c) => c.action === "removed").length;
    ctx.ui.ok(
      remaining.length
        ? `Removed ${[...drop].map((h) => HOSTS[h].name).join(", ")}; kept ${remaining.map((h) => HOSTS[h].name).join(", ")}`
        : "Removed Sillo Agent",
      `${removed} files and blocks removed`,
    );
  }
  if (flags.dryRun) ctx.ui.line("Dry run: nothing was removed.");
  return failures ? 1 : 0;
}

function wrap(
  text: string,
  width: number,
  indent: string,
  ui: { paint: (t: "gray", s: string) => string },
): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width) {
      lines.push(line.trim());
      line = word;
    } else line += ` ${word}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l) => indent + ui.paint("gray", l)).join("\n");
}
