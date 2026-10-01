import path from "node:path";
import { AgentError } from "../core/errors.js";
import { currentEnvironment, type Environment } from "../core/paths.js";
import { Ui, type Writer } from "../core/ui.js";
import {
  type CapabilityCatalog,
  loadCapabilities,
  loadVersions,
  type VersionCatalog,
} from "../framework/catalog.js";
import type { HostContext, Scope } from "../hosts/types.js";
import { readManifest } from "../install/manifest.js";
import { detectProject, findProjectRoot } from "../project/detect.js";
import { builtinSkillsDir, loadSkills } from "../skills/load.js";
import type { Skill } from "../skills/schema.js";

export interface Io {
  stdout: Writer;
  stderr: Writer;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface Catalog {
  skills: Skill[];
  capabilities: CapabilityCatalog;
  versions: VersionCatalog;
}

let cached: Catalog | undefined;

export async function loadCatalog(skillsDir = builtinSkillsDir()): Promise<Catalog> {
  if (cached && skillsDir === builtinSkillsDir()) return cached;
  const catalog = {
    skills: await loadSkills(skillsDir),
    capabilities: await loadCapabilities(),
    versions: await loadVersions(),
  };
  if (skillsDir === builtinSkillsDir()) cached = catalog;
  return catalog;
}

export class Context {
  readonly envr: Environment;
  readonly ui: Ui;
  readonly err: Ui;

  constructor(
    readonly io: Io,
    options: { color?: boolean; quiet?: boolean } = {},
  ) {
    this.envr = currentEnvironment({ env: io.env, cwd: io.cwd });
    const uiOptions: { color?: boolean; quiet?: boolean } = {};
    if (options.color !== undefined) uiOptions.color = options.color;
    if (options.quiet !== undefined) uiOptions.quiet = options.quiet;
    this.ui = new Ui(io.stdout, io.env, uiOptions);
    this.err = new Ui(io.stderr, io.env, uiOptions);
  }

  async projectRoot(dir?: string): Promise<string> {
    return findProjectRoot(dir ? path.resolve(this.envr.cwd, dir) : this.envr.cwd);
  }

  async hostContext(dir?: string): Promise<HostContext> {
    return { envr: this.envr, projectRoot: await this.projectRoot(dir) };
  }

  /** The scopes that currently have a manifest, for update/status/uninstall. */
  async installedScopes(dir?: string): Promise<Scope[]> {
    const hctx = await this.hostContext(dir);
    const scopes: Scope[] = [];
    if (path.resolve(hctx.projectRoot) !== path.resolve(this.envr.home)) {
      if ((await readManifest(hctx.projectRoot)).state !== "missing") scopes.push("project");
    }
    if ((await readManifest(this.envr.home)).state !== "missing") scopes.push("global");
    return scopes;
  }

  async detect(dir?: string) {
    return detectProject(dir ? path.resolve(this.envr.cwd, dir) : this.envr.cwd);
  }
}

export function scopeFromFlags(flags: { global?: boolean; project?: boolean }): Scope | undefined {
  if (flags.global && flags.project) {
    throw new AgentError("Choose one of --global and --project.", { exitCode: 2 });
  }
  if (flags.global) return "global";
  if (flags.project) return "project";
  return undefined;
}
