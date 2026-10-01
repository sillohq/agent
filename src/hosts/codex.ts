import path from "node:path";
import { isDirectory, which } from "../core/fs.js";
import type { Environment } from "../core/paths.js";
import type { HostAdapter, SkillLocation } from "./types.js";

/**
 * Codex (CLI, IDE extension and app).
 *
 * - Skills are read from `.agents/skills` in the working directory, its
 *   parents up to the repository root, and `$HOME/.agents/skills` for the
 *   user; built-in skills live under `$CODEX_HOME/skills/.system`. Older
 *   releases read user skills from `$CODEX_HOME/skills` (`~/.codex/skills`).
 * - Frontmatter: `name` and `description` are required. The initial skills
 *   list is capped at 8,000 characters; descriptions are shortened first.
 * - Optional `agents/openai.yaml` carries UI metadata (`interface.display_name`).
 * - Always-loaded instructions: `AGENTS.md` from the repository root down to
 *   the working directory, plus `$CODEX_HOME/AGENTS.md`, up to 32 KiB.
 */
export function codexHome(envr: Environment): string {
  return envr.env.CODEX_HOME ?? path.join(envr.home, ".codex");
}

/** Where earlier Codex releases looked for user skills. Checked by doctor only. */
export function codexLegacySkillsDir(envr: Environment): string {
  return path.join(codexHome(envr), "skills");
}

export const codex: HostAdapter = {
  id: "codex",
  name: "Codex",
  reference: "https://developers.openai.com/codex/skills",

  async detect(envr) {
    const evidence: string[] = [];
    const bin = await which("codex", envr.env, envr.platform);
    if (bin) evidence.push(`codex on PATH (${bin})`);
    const home = codexHome(envr);
    if (await isDirectory(home)) evidence.push(`${home} exists`);
    return { found: evidence.length > 0, evidence };
  },

  ownSkills(scope, ctx): SkillLocation {
    const dir =
      scope === "global"
        ? path.join(ctx.envr.home, ".agents", "skills")
        : path.join(ctx.projectRoot, ".agents", "skills");
    return { dir, format: "agents", kind: "agents" };
  },

  readableSkills(scope, ctx) {
    return [this.ownSkills(scope, ctx)];
  },

  instructions(scope, ctx) {
    return scope === "global"
      ? path.join(codexHome(ctx.envr), "AGENTS.md")
      : path.join(ctx.projectRoot, "AGENTS.md");
  },
};
