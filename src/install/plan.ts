import path from "node:path";
import { sha256 } from "../core/fs.js";
import { isWithin, toPortable } from "../core/paths.js";
import type { VersionCatalog } from "../framework/catalog.js";
import { HOSTS } from "../hosts/index.js";
import type { HostContext, HostId, Scope, SkillLocation } from "../hosts/types.js";
import { renderSkill } from "../skills/render.js";
import type { Skill } from "../skills/schema.js";
import { renderBlock } from "./instructions.js";

export interface PlannedLocation {
  location: SkillLocation;
  hosts: HostId[];
}

export interface DesiredFile {
  abs: string;
  /** Manifest key: relative to the scope root when inside it, else absolute. */
  key: string;
  content: string;
  sha256: string;
  skill: string;
  /** The skills directory it lives under (the write-safety root). */
  locationDir: string;
  hosts: HostId[];
}

export interface DesiredBlock {
  abs: string;
  key: string;
  content: string;
  sha256: string;
  hosts: HostId[];
}

export interface Plan {
  scope: Scope;
  root: string;
  hosts: HostId[];
  locations: PlannedLocation[];
  files: DesiredFile[];
  blocks: DesiredBlock[];
}

export interface PlanInput {
  scope: Scope;
  hosts: HostId[];
  ctx: HostContext;
  skills: Skill[];
  versions: VersionCatalog;
  instructions: boolean;
}

export function scopeRoot(scope: Scope, ctx: HostContext): string {
  return scope === "global" ? ctx.envr.home : ctx.projectRoot;
}

export function manifestKey(root: string, abs: string): string {
  return isWithin(root, abs) ? toPortable(root, abs) : path.resolve(abs);
}

/**
 * Choose where skills go so that every selected host sees each skill exactly
 * once. Claude and Codex each have one location; OpenCode also reads theirs,
 * so it shares one when it can (the Agent Skills directory first, since that is
 * the vendor-neutral one) and only gets its own copy when it cannot.
 */
export function planLocations(scope: Scope, hosts: HostId[], ctx: HostContext): PlannedLocation[] {
  const planned = new Map<string, PlannedLocation>();
  const add = (location: SkillLocation, host: HostId) => {
    const key = path.resolve(location.dir);
    const existing = planned.get(key);
    if (existing) {
      if (!existing.hosts.includes(host)) existing.hosts.push(host);
    } else planned.set(key, { location, hosts: [host] });
  };
  for (const host of hosts) {
    if (host === "opencode") continue;
    add(HOSTS[host].ownSkills(scope, ctx), host);
  }
  if (hosts.includes("opencode")) {
    const readable = HOSTS.opencode.readableSkills(scope, ctx);
    const shared =
      readable.find((l) => l.kind === "agents" && planned.has(path.resolve(l.dir))) ??
      readable.find((l) => l.kind === "claude" && planned.has(path.resolve(l.dir)));
    add(
      shared
        ? planned.get(path.resolve(shared.dir))!.location
        : HOSTS.opencode.ownSkills(scope, ctx),
      "opencode",
    );
  }
  return [...planned.values()];
}

/** Which instructions file each host reads, merged where hosts share one. */
export function planInstructionFiles(
  scope: Scope,
  hosts: HostId[],
  ctx: HostContext,
): Array<{ abs: string; hosts: HostId[] }> {
  const files = new Map<string, HostId[]>();
  for (const host of hosts) {
    const abs = path.resolve(HOSTS[host].instructions(scope, ctx));
    files.set(abs, [...(files.get(abs) ?? []), host]);
  }
  return [...files.entries()].map(([abs, h]) => ({ abs, hosts: h }));
}

export function buildPlan(input: PlanInput): Plan {
  const root = scopeRoot(input.scope, input.ctx);
  const locations = planLocations(input.scope, input.hosts, input.ctx);
  const files: DesiredFile[] = [];
  for (const { location, hosts } of locations) {
    for (const skill of input.skills) {
      for (const file of renderSkill(skill, location.format, { versions: input.versions })) {
        const abs = path.join(location.dir, skill.meta.name, ...file.path.split("/"));
        files.push({
          abs,
          key: manifestKey(root, abs),
          content: file.content,
          sha256: sha256(file.content),
          skill: skill.meta.name,
          locationDir: location.dir,
          hosts: [...hosts].sort(),
        });
      }
    }
  }
  const blocks: DesiredBlock[] = [];
  if (input.instructions) {
    const content = renderBlock();
    for (const { abs, hosts } of planInstructionFiles(input.scope, input.hosts, input.ctx)) {
      blocks.push({
        abs,
        key: manifestKey(root, abs),
        content,
        sha256: sha256(content),
        hosts: hosts.sort(),
      });
    }
  }
  return { scope: input.scope, root, hosts: [...input.hosts].sort(), locations, files, blocks };
}

/**
 * Every place a file owned by this tool may legitimately live in a scope,
 * across all hosts, whether selected or not. A manifest entry resolving
 * anywhere else is refused, so a tampered manifest cannot aim a delete at an
 * arbitrary file.
 */
export function allowedRoots(
  scope: Scope,
  ctx: HostContext,
): { skillDirs: string[]; instructionFiles: string[] } {
  const skillDirs = new Set<string>();
  const instructionFiles = new Set<string>();
  for (const adapter of Object.values(HOSTS)) {
    skillDirs.add(path.resolve(adapter.ownSkills(scope, ctx).dir));
    for (const loc of adapter.readableSkills(scope, ctx)) skillDirs.add(path.resolve(loc.dir));
    instructionFiles.add(path.resolve(adapter.instructions(scope, ctx)));
  }
  return { skillDirs: [...skillDirs], instructionFiles: [...instructionFiles] };
}

/** The skills directory an owned file lives under, if it is a legitimate one. */
export function owningSkillDir(abs: string, allowed: { skillDirs: string[] }): string | undefined {
  for (const dir of allowed.skillDirs) {
    if (!isWithin(dir, abs)) continue;
    const first = path.relative(dir, abs).split(path.sep)[0] ?? "";
    if (/^sillo(-[a-z0-9]+)*$/.test(first)) return dir;
  }
  return undefined;
}
