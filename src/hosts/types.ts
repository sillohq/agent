import type { Environment } from "../core/paths.js";
import type { SkillFormat } from "../skills/render.js";

export type HostId = "claude" | "opencode" | "codex";
export type Scope = "global" | "project";

export const HOST_IDS: readonly HostId[] = ["claude", "opencode", "codex"] as const;

export interface HostContext {
  envr: Environment;
  /** The project root, for project scope. */
  projectRoot: string;
}

/** A directory a host reads skills from, and the dialect it expects there. */
export interface SkillLocation {
  dir: string;
  format: SkillFormat;
  /** Short description for output: ".claude/skills", "~/.agents/skills". */
  kind: "claude" | "agents" | "opencode";
}

export interface Detection {
  found: boolean;
  evidence: string[];
}

/**
 * Everything specific to one coding agent. Adapters describe the host; they do
 * not decide what to install and they carry no Sillo knowledge — the planner
 * combines adapters, and the knowledge comes from the canonical skills.
 */
export interface HostAdapter {
  id: HostId;
  name: string;
  /** Where the facts in this adapter come from. */
  reference: string;
  detect(envr: Environment): Promise<Detection>;
  /**
   * Where this host would install skills of its own in a scope. Every host
   * reads its own location.
   */
  ownSkills(scope: Scope, ctx: HostContext): SkillLocation;
  /**
   * Every location this host reads skills from in a scope, including ones it
   * shares with other hosts. The planner uses this to avoid writing the same
   * skill twice where one copy would be seen by both.
   */
  readableSkills(scope: Scope, ctx: HostContext): SkillLocation[];
  /** The always-loaded instructions file for a scope. */
  instructions(scope: Scope, ctx: HostContext): string;
}
