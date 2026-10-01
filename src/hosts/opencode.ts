import path from "node:path";
import { isDirectory, which } from "../core/fs.js";
import type { Environment } from "../core/paths.js";
import type { HostAdapter, SkillLocation } from "./types.js";

/**
 * OpenCode.
 *
 * - Skills: `.opencode/skills/<name>/SKILL.md` in the project and the global
 *   config directory's `skills/` (`~/.config/opencode/skills`). It also reads
 *   the Claude and Agent Skills locations — `.claude/skills`, `.agents/skills`
 *   and their `~/` equivalents — unless `OPENCODE_DISABLE_EXTERNAL_SKILLS` is
 *   set; `OPENCODE_DISABLE_CLAUDE_CODE(_SKILLS)` drops only the Claude ones.
 *   A skill name seen twice is logged as a duplicate and the later one wins.
 * - Frontmatter: `name` (^[a-z0-9]+(-[a-z0-9]+)*$, matching its directory)
 *   and `description` (1–1024 characters) are required; `metadata` must be a
 *   string-to-string map. Loaded on demand through the `skill` tool.
 * - Always-loaded instructions: `AGENTS.md` (falling back to `CLAUDE.md`)
 *   walking up from the working directory, and `~/.config/opencode/AGENTS.md`.
 *
 * Verified against anomalyco/opencode packages/opencode/src/skill/index.ts.
 */
function flag(envr: Environment, name: string): boolean {
  const v = envr.env[name];
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

export function opencodeConfigDir(envr: Environment): string {
  if (envr.env.OPENCODE_CONFIG_DIR) return envr.env.OPENCODE_CONFIG_DIR;
  const xdg = envr.env.XDG_CONFIG_HOME ?? path.join(envr.home, ".config");
  return path.join(xdg, "opencode");
}

export function opencodeReadsExternal(envr: Environment): { agents: boolean; claude: boolean } {
  const external = !flag(envr, "OPENCODE_DISABLE_EXTERNAL_SKILLS");
  const claudeOff =
    flag(envr, "OPENCODE_DISABLE_CLAUDE_CODE") || flag(envr, "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS");
  return { agents: external, claude: external && !claudeOff };
}

export const opencode: HostAdapter = {
  id: "opencode",
  name: "OpenCode",
  reference: "https://opencode.ai/docs/skills/",

  async detect(envr) {
    const evidence: string[] = [];
    const bin = await which("opencode", envr.env, envr.platform);
    if (bin) evidence.push(`opencode on PATH (${bin})`);
    const dir = opencodeConfigDir(envr);
    if (await isDirectory(dir)) evidence.push(`${dir} exists`);
    const installDir = path.join(envr.home, ".opencode", "bin");
    if (await isDirectory(installDir)) evidence.push(`${installDir} exists`);
    return { found: evidence.length > 0, evidence };
  },

  ownSkills(scope, ctx): SkillLocation {
    const dir =
      scope === "global"
        ? path.join(opencodeConfigDir(ctx.envr), "skills")
        : path.join(ctx.projectRoot, ".opencode", "skills");
    return { dir, format: "agents", kind: "opencode" };
  },

  readableSkills(scope, ctx) {
    const reads = opencodeReadsExternal(ctx.envr);
    const base = scope === "global" ? ctx.envr.home : ctx.projectRoot;
    const out: SkillLocation[] = [this.ownSkills(scope, ctx)];
    if (reads.agents)
      out.push({ dir: path.join(base, ".agents", "skills"), format: "agents", kind: "agents" });
    // OpenCode reads ~/.claude, not CLAUDE_CONFIG_DIR, so the planner only
    // shares a Claude directory with it when the two actually coincide.
    if (reads.claude)
      out.push({ dir: path.join(base, ".claude", "skills"), format: "claude", kind: "claude" });
    return out;
  },

  instructions(scope, ctx) {
    return scope === "global"
      ? path.join(opencodeConfigDir(ctx.envr), "AGENTS.md")
      : path.join(ctx.projectRoot, "AGENTS.md");
  },
};
