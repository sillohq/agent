import path from "node:path";
import { isDirectory, which } from "../core/fs.js";
import type { Environment } from "../core/paths.js";
import type { HostAdapter, HostContext, Scope, SkillLocation } from "./types.js";

/**
 * Claude Code.
 *
 * - Personal skills: `~/.claude/skills/<name>/SKILL.md` (the config directory
 *   moves with `CLAUDE_CONFIG_DIR`).
 * - Project skills: `.claude/skills/<name>/SKILL.md`, committed with the repo.
 * - Frontmatter: `name`, `description`, `when_to_use` (shares a 1,536-character
 *   listing budget with the description), `metadata`, among others. Only
 *   descriptions are always in context; the body loads when invoked.
 * - Always-loaded instructions: `CLAUDE.md` (project) and `~/.claude/CLAUDE.md`.
 */
export function claudeConfigDir(envr: Environment): string {
  return envr.env.CLAUDE_CONFIG_DIR ?? path.join(envr.home, ".claude");
}

export const claude: HostAdapter = {
  id: "claude",
  name: "Claude Code",
  reference: "https://code.claude.com/docs/en/skills",

  async detect(envr) {
    const evidence: string[] = [];
    const bin = await which("claude", envr.env, envr.platform);
    if (bin) evidence.push(`claude on PATH (${bin})`);
    const dir = claudeConfigDir(envr);
    if (await isDirectory(dir)) evidence.push(`${dir} exists`);
    return { found: evidence.length > 0, evidence };
  },

  ownSkills(scope: Scope, ctx: HostContext): SkillLocation {
    const dir =
      scope === "global"
        ? path.join(claudeConfigDir(ctx.envr), "skills")
        : path.join(ctx.projectRoot, ".claude", "skills");
    return { dir, format: "claude", kind: "claude" };
  },

  readableSkills(scope, ctx) {
    return [this.ownSkills(scope, ctx)];
  },

  instructions(scope, ctx) {
    return scope === "global"
      ? path.join(claudeConfigDir(ctx.envr), "CLAUDE.md")
      : path.join(ctx.projectRoot, "CLAUDE.md");
  },
};
