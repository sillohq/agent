/**
 * The canonical Sillo skill: one directory under `skills/`, named exactly as it
 * is installed, holding a `SKILL.md` whose frontmatter is a superset of what
 * any host reads. Host adapters render it down; nothing host-specific lives in
 * the canonical file.
 */

export type SkillStatus = "stable" | "draft" | "deprecated";

export interface SkillFrontmatter {
  /** Installed name and directory name. `sillo` or `sillo-<topic>`. */
  name: string;
  /** Human title, used as the H1 and in listings. */
  title: string;
  /**
   * What the skill covers and when to reach for it. This is the text a host
   * shows its model before the skill is loaded, so it carries the routing.
   */
  description: string;
  /**
   * Natural-language requests this skill answers. Examples of intent, not a
   * keyword list: they are rendered as usage guidance and drive the routing
   * evaluation.
   */
  intents: string[];
  /** Capability ids from framework/capabilities.yml this skill covers. */
  capabilities: string[];
  /** Skills that are commonly combined with this one. */
  related: string[];
  /** Skills whose knowledge this one assumes. */
  requires: string[];
  /** The Sillo versions this guidance is written against (PEP 440-ish range). */
  sillo: string;
  /** Python distributions (with extras) the feature needs installed. */
  packages: string[];
  /** Public symbols the skill teaches, fully qualified. Checked against the surface. */
  symbols: string[];
  /** Probe ids (framework/probes) that verify the behaviour the skill describes. */
  probes: string[];
  /** Where the knowledge came from: `core:<path>`, `docs:<path>`, `pkg:<name>/<path>`. */
  sources: string[];
  status: SkillStatus;
}

export interface SkillFile {
  /** Path relative to the skill directory, `/`-separated. */
  path: string;
  content: string;
}

export interface Skill {
  meta: SkillFrontmatter;
  /** Markdown after the frontmatter. */
  body: string;
  /** Every file in the skill directory other than SKILL.md. */
  files: SkillFile[];
  /** Absolute path of the skill directory, for error messages. */
  dir: string;
  /** Where the skill came from: the bundled catalog, or a package's own. */
  origin: SkillOrigin;
}

export type SkillOrigin =
  | { kind: "builtin" }
  | { kind: "package"; distribution: string; path: string };

/** The sections every production skill body must have, in order. */
export const REQUIRED_SECTIONS = [
  "When",
  "Inspect first",
  "How",
  "Compose",
  "Verify",
  "Avoid",
] as const;

export const SKILL_NAME_PATTERN = /^sillo(-[a-z0-9]+)*$/;
export const BASE_SKILL = "sillo";

/** Hard limits, chosen from the strictest host. */
export const LIMITS = {
  /** OpenCode and the Agent Skills spec: 1–64 characters. */
  nameMax: 64,
  /**
   * Codex shortens descriptions once the whole list passes 8,000 characters,
   * so each one is kept short enough that ~45 skills fit untruncated.
   */
  descriptionMax: 240,
  descriptionMin: 60,
  /** Claude Code truncates description + when_to_use at 1,536 characters. */
  claudeListingMax: 1536,
  /** Codex's budget for the whole initial skills list. */
  codexListingBudget: 8000,
  /** Keep the entrypoint small; depth belongs in references/. */
  bodyMaxLines: 420,
  intentsMin: 3,
} as const;
