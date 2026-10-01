import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readText, sha256, which } from "../../core/fs.js";
import { displayPath } from "../../core/paths.js";
import { satisfies } from "../../core/pep440.js";
import { computeCoverage } from "../../framework/coverage.js";
import { codexLegacySkillsDir } from "../../hosts/codex.js";
import { HOSTS } from "../../hosts/index.js";
import { HOST_IDS, type HostContext, type Scope } from "../../hosts/types.js";
import { findBlock } from "../../install/instructions.js";
import { type Manifest, readManifest } from "../../install/manifest.js";
import { allowedRoots } from "../../install/plan.js";
import type { ProjectInfo } from "../../project/detect.js";
import { GENERATED_MARKER } from "../../skills/render.js";
import { AGENT_VERSION } from "../../version.js";
import { type Context, loadCatalog, scopeFromFlags } from "../context.js";

const run = promisify(execFile);

export interface FileHealth {
  ok: number;
  modified: string[];
  missing: string[];
  blocksOk: number;
  blocksModified: string[];
  blocksMissing: string[];
}

function resolveKey(root: string, key: string): string {
  return path.isAbsolute(key) ? key : path.resolve(root, ...key.split("/"));
}

export async function manifestHealth(root: string, manifest: Manifest): Promise<FileHealth> {
  const health: FileHealth = {
    ok: 0,
    modified: [],
    missing: [],
    blocksOk: 0,
    blocksModified: [],
    blocksMissing: [],
  };
  for (const f of manifest.files) {
    const abs = resolveKey(root, f.path);
    const text = await readText(abs);
    if (text === undefined) health.missing.push(abs);
    else if (sha256(text) !== f.sha256) health.modified.push(abs);
    else health.ok++;
  }
  for (const b of manifest.blocks) {
    const abs = resolveKey(root, b.file);
    const text = await readText(abs);
    const found = text === undefined ? undefined : findBlock(text);
    if (!found || found === "unbalanced") health.blocksMissing.push(abs);
    else if (sha256(found.inner) !== b.sha256) health.blocksModified.push(abs);
    else health.blocksOk++;
  }
  return health;
}

export async function status(
  ctx: Context,
  flags: { global?: boolean; project?: boolean; dir?: string; json?: boolean },
): Promise<number> {
  const only = scopeFromFlags(flags);
  const hctx = await ctx.hostContext(flags.dir);
  const scopes: Scope[] = only ? [only] : ["project", "global"];
  const report: Array<Record<string, unknown>> = [];
  const ui = ctx.ui;
  ui.heading(`Sillo Agent ${AGENT_VERSION}`);
  for (const scope of scopes) {
    const root = scope === "global" ? ctx.envr.home : hctx.projectRoot;
    if (scope === "project" && path.resolve(root) === path.resolve(ctx.envr.home)) continue;
    const read = await readManifest(root);
    ui.section(
      `${scope === "global" ? "Global" : "Project"}  ${ui.paint("gray", displayPath(root, ctx.envr))}`,
    );
    if (read.state === "missing") {
      ui.skip("not installed");
      report.push({ scope, installed: false });
      continue;
    }
    if (read.state === "corrupt") {
      ui.fail("manifest is unreadable", read.reason);
      ui.muted("    run `sillo-agent update` to rebuild it from the generated files");
      report.push({ scope, installed: true, corrupt: read.reason });
      continue;
    }
    const m = read.manifest;
    const health = await manifestHealth(root, m);
    const skills = new Set(m.files.map((f) => f.skill)).size;
    ui.pairs([
      ["agents", m.hosts.map((h) => HOSTS[h].name).join(", ") || "none"],
      ["skills", `${skills} (${m.files.length} files)`],
      [
        "installed by",
        `@sillo/agent ${m.version}${m.version !== AGENT_VERSION ? ui.paint("yellow", `  → ${AGENT_VERSION} available: sillo-agent update`) : ""}`,
      ],
      ["updated", m.updatedAt],
    ]);
    if (health.modified.length)
      ui.warn(
        `${health.modified.length} file(s) edited locally`,
        "kept on update; --force replaces them",
      );
    if (health.missing.length)
      ui.warn(`${health.missing.length} file(s) missing`, "sillo-agent update restores them");
    for (const b of health.blocksMissing)
      ui.warn(`instructions block missing from ${displayPath(b, ctx.envr)}`);
    if (!health.modified.length && !health.missing.length && !health.blocksMissing.length)
      ui.ok("all files intact");
    report.push({ scope, installed: true, hosts: m.hosts, version: m.version, skills, health });
  }
  if (flags.json) ctx.io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

interface Check {
  group: string;
  level: "ok" | "warn" | "fail" | "info";
  text: string;
  detail?: string;
}

async function pythonVersion(
  ctx: Context,
  project?: ProjectInfo,
): Promise<{ bin?: string; version?: string }> {
  const candidates: string[] = [];
  if (project?.virtualenv) {
    candidates.push(path.join(project.root, project.virtualenv, "bin", "python"));
    candidates.push(path.join(project.root, project.virtualenv, "Scripts", "python.exe"));
  }
  for (const name of ["python3", "python"]) {
    const found = await which(name, ctx.envr.env, ctx.envr.platform);
    if (found) candidates.push(found);
  }
  for (const bin of candidates) {
    try {
      const { stdout, stderr } = await run(bin, ["--version"], {
        timeout: 5000,
        env: ctx.envr.env,
      });
      const version = (stdout || stderr).trim().replace(/^Python\s+/i, "");
      if (version) return { bin, version };
    } catch {
      // try the next
    }
  }
  return {};
}

export async function doctor(
  ctx: Context,
  flags: { dir?: string; json?: boolean },
): Promise<number> {
  const checks: Check[] = [];
  const add = (group: string, level: Check["level"], text: string, detail?: string) => {
    const check: Check = { group, level, text };
    if (detail) check.detail = detail;
    checks.push(check);
  };
  const catalog = await loadCatalog();
  const hctx: HostContext = await ctx.hostContext(flags.dir);

  // Environment
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add(
    "Environment",
    nodeMajor >= 20 ? "ok" : "fail",
    `Node ${process.versions.node}`,
    nodeMajor >= 20 ? undefined : "Node 20.12 or newer is required",
  );
  const project = await ctx.detect(flags.dir);
  const py = await pythonVersion(ctx, project.isSillo ? project : undefined);
  add(
    "Environment",
    py.version ? "ok" : "warn",
    py.version ? `Python ${py.version}` : "Python not found",
    py.bin ? displayPath(py.bin, ctx.envr) : "agents need it to run Sillo and its tests",
  );

  // Project
  if (project.isSillo) {
    add(
      "Project",
      "ok",
      `Sillo project detected (${project.confidence} confidence)`,
      displayPath(project.root, ctx.envr),
    );
    if (project.version) {
      const supported = satisfies(project.version.version, catalog.versions.supported);
      add(
        "Project",
        supported ? "ok" : "warn",
        `Sillo ${project.version.version}`,
        supported
          ? `from ${project.version.source}`
          : `skills target ${catalog.versions.supported}; agents will fall back to the installed source`,
      );
    } else {
      add(
        "Project",
        "warn",
        "Sillo version unknown",
        "no lock file or virtual environment; declared: " + (project.declared?.spec ?? "nothing"),
      );
    }
    if (project.app) add("Project", "ok", `app ${project.app}`, "[tool.sillo]");
    for (const pkg of project.packages)
      add("Project", "info", `${pkg.name}${pkg.version ? ` ${pkg.version}` : ""}`, pkg.source);
  } else {
    add("Project", "info", "Not inside a Sillo project", "project checks skipped");
  }

  // Integrations
  const scopes: Scope[] = ["global", "project"];
  const installed = new Map<Scope, Manifest>();
  for (const scope of scopes) {
    const root = scope === "global" ? ctx.envr.home : hctx.projectRoot;
    if (scope === "project" && path.resolve(root) === path.resolve(ctx.envr.home)) continue;
    const read = await readManifest(root);
    if (read.state === "ok") installed.set(scope, read.manifest);
    if (read.state === "corrupt")
      add(
        "Integrations",
        "fail",
        `${scope} manifest is corrupt`,
        "run sillo-agent update to rebuild it",
      );
  }
  for (const id of HOST_IDS) {
    const detection = await HOSTS[id].detect(ctx.envr);
    const where = [...installed.entries()].filter(([, m]) => m.hosts.includes(id)).map(([s]) => s);
    if (where.length) add("Integrations", "ok", HOSTS[id].name, `installed (${where.join(", ")})`);
    else if (detection.found)
      add(
        "Integrations",
        "warn",
        HOSTS[id].name,
        `detected but not installed: sillo-agent install ${id}`,
      );
    else add("Integrations", "info", HOSTS[id].name, "not detected");
  }

  // Skills
  const expected = catalog.skills.filter((s) => s.meta.status !== "draft").length;
  for (const [scope, m] of installed) {
    const root = scope === "global" ? ctx.envr.home : hctx.projectRoot;
    const health = await manifestHealth(root, m);
    const skills = new Set(m.files.map((f) => f.skill)).size;
    const perLocation = new Set(m.files.map((f) => f.location)).size || 1;
    add(
      "Skills",
      skills >= expected ? "ok" : "warn",
      `${skills} skills installed (${scope})`,
      skills >= expected
        ? `${perLocation} location(s)`
        : `catalog has ${expected}; run sillo-agent update`,
    );
    add(
      "Skills",
      m.version === AGENT_VERSION ? "ok" : "warn",
      m.version === AGENT_VERSION
        ? `Up to date (${scope})`
        : `Installed by ${m.version} (${scope})`,
      m.version === AGENT_VERSION ? undefined : "sillo-agent update",
    );
    if (health.modified.length)
      add(
        "Skills",
        "warn",
        `${health.modified.length} edited file(s) (${scope})`,
        "kept on update",
      );
    if (health.missing.length)
      add(
        "Skills",
        "warn",
        `${health.missing.length} missing file(s) (${scope})`,
        "sillo-agent update restores them",
      );
    if (!health.modified.length && !health.missing.length)
      add("Skills", "ok", `No stale or edited files (${scope})`);
  }

  // Generated skills nobody owns any more, and duplicates across scopes.
  for (const scope of scopes) {
    const root = scope === "global" ? ctx.envr.home : hctx.projectRoot;
    if (scope === "project" && path.resolve(root) === path.resolve(ctx.envr.home)) continue;
    const owned = new Set(
      (installed.get(scope)?.files ?? []).map((f) =>
        path.dirname(path.isAbsolute(f.path) ? f.path : path.resolve(root, f.path)),
      ),
    );
    for (const dir of allowedRoots(scope, hctx).skillDirs) {
      let names: string[] = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.filter((n) => /^sillo(-[a-z0-9]+)*$/.test(n))) {
        const skillDir = path.join(dir, name);
        const text = await readText(path.join(skillDir, "SKILL.md"));
        if (text?.includes(GENERATED_MARKER) && !owned.has(skillDir)) {
          add(
            "Skills",
            "warn",
            `Orphaned generated skill ${displayPath(skillDir, ctx.envr)}`,
            "not in any manifest; sillo-agent update adopts or removes it",
          );
        }
      }
    }
  }
  if (installed.has("global") && installed.has("project")) {
    const shared = installed
      .get("global")!
      .hosts.filter((h) => installed.get("project")!.hosts.includes(h));
    if (shared.length) {
      add(
        "Skills",
        "warn",
        `Installed both globally and in this project for ${shared.map((h) => HOSTS[h].name).join(", ")}`,
        "agents see each skill twice; uninstall one scope",
      );
    }
  }
  const legacy = codexLegacySkillsDir(ctx.envr);
  try {
    const names = await fs.readdir(legacy);
    if (names.some((n) => /^sillo(-[a-z0-9]+)*$/.test(n))) {
      add(
        "Skills",
        "warn",
        `Sillo skills in ${displayPath(legacy, ctx.envr)}`,
        "the legacy Codex location; current Codex reads ~/.agents/skills",
      );
    }
  } catch {
    // no legacy directory
  }

  // Coverage
  const coverage = computeCoverage(catalog.capabilities, catalog.skills);
  add(
    "Coverage",
    coverage.covered === coverage.required ? "ok" : "warn",
    `${coverage.covered}/${coverage.required} Sillo capabilities covered (${coverage.percent}%)`,
    `${coverage.absentDocumented}/${coverage.absentTotal} absent features documented as absent`,
  );
  if (
    project.isSillo &&
    project.version &&
    !satisfies(project.version.version, catalog.versions.supported)
  ) {
    const legacyNote = catalog.versions.legacy.find((l) =>
      satisfies(project.version!.version, l.range),
    );
    if (legacyNote)
      add(
        "Coverage",
        "warn",
        `Sillo ${project.version.version} predates these skills`,
        legacyNote.note.split("\n")[0],
      );
  }

  if (flags.json) {
    ctx.io.stdout.write(
      `${JSON.stringify({ checks, project, coverage: { ...coverage, rows: undefined } }, null, 2)}\n`,
    );
    return checks.some((c) => c.level === "fail") ? 1 : 0;
  }
  const ui = ctx.ui;
  ui.heading("Sillo Agent Doctor");
  let group = "";
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      ui.section(group);
    }
    if (c.level === "ok") ui.ok(c.text, c.detail);
    else if (c.level === "warn") ui.warn(c.text, c.detail);
    else if (c.level === "fail") ui.fail(c.text, c.detail);
    else ui.info(c.text, c.detail);
  }
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  ui.line();
  ui.line(
    fails
      ? ui.paint("red", `${fails} problem(s), ${warns} warning(s)`)
      : warns
        ? ui.paint("yellow", `No problems, ${warns} warning(s)`)
        : ui.paint("green", "Everything looks good."),
  );
  return fails ? 1 : 0;
}

export async function info(
  ctx: Context,
  dir: string | undefined,
  flags: { json?: boolean },
): Promise<number> {
  const project = await ctx.detect(dir);
  const catalog = await loadCatalog();
  if (flags.json) {
    ctx.io.stdout.write(
      `${JSON.stringify({ ...project, supported: catalog.versions.supported }, null, 2)}\n`,
    );
    return project.isSillo ? 0 : 3;
  }
  const ui = ctx.ui;
  ui.heading("Project");
  const rows: Array<[string, string]> = [
    ["root", displayPath(project.root, ctx.envr)],
    [
      "framework",
      project.isSillo ? `Sillo (${project.confidence} confidence)` : "not a Sillo project",
    ],
  ];
  if (project.version) {
    const supported = satisfies(project.version.version, catalog.versions.supported);
    rows.push([
      "version",
      `${project.version.version}  ${ui.paint("gray", project.version.source)}${supported ? "" : ui.paint("yellow", `  (skills target ${catalog.versions.supported})`)}`,
    ]);
  }
  if (project.declared)
    rows.push([
      "declared",
      `${project.declared.spec}  ${ui.paint("gray", project.declared.source)}`,
    ]);
  if (project.extras.length) rows.push(["extras", project.extras.join(", ")]);
  if (project.app) rows.push(["app", project.app]);
  if (project.packages.length)
    rows.push([
      "packages",
      project.packages.map((p) => `${p.name}${p.version ? ` ${p.version}` : ""}`).join(", "),
    ]);
  if (project.uses.length) rows.push(["uses", project.uses.join(", ")]);
  if (project.packageManager) rows.push(["manager", project.packageManager]);
  if (project.tests) rows.push(["tests", project.tests]);
  if (project.virtualenv) rows.push(["venv", project.virtualenv]);
  ui.pairs(rows);
  if (project.evidence.length) {
    ui.section("Evidence");
    for (const e of project.evidence) ui.info(e);
  }
  return project.isSillo ? 0 : 3;
}
