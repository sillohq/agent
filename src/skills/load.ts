import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { AgentError } from "../core/errors.js";
import { listFiles } from "../core/fs.js";
import type { Skill, SkillFrontmatter, SkillOrigin, SkillStatus } from "./schema.js";

/** The package root: two levels above dist/skills or src/skills. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function builtinSkillsDir(): string {
  return path.join(packageRoot(), "skills");
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedMarkdown {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(text: string, source: string): ParsedMarkdown {
  const match = FRONTMATTER.exec(text);
  if (!match) {
    throw new AgentError(`${source}: missing YAML frontmatter (--- … ---).`);
  }
  let data: unknown;
  try {
    data = YAML.parse(match[1] ?? "", { strict: true, uniqueKeys: true });
  } catch (error) {
    throw new AgentError(`${source}: frontmatter is not valid YAML: ${(error as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new AgentError(`${source}: frontmatter must be a mapping.`);
  }
  return { data: data as Record<string, unknown>, body: match[2] ?? "" };
}

function strings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

/**
 * Coerce parsed frontmatter into the canonical shape. Missing or malformed
 * fields become empty values here and are reported by validation, so that one
 * broken skill produces a list of problems rather than a crash.
 */
export function toFrontmatter(data: Record<string, unknown>): SkillFrontmatter {
  return {
    name: String(data.name ?? ""),
    title: String(data.title ?? ""),
    description: String(data.description ?? "").trim(),
    intents: strings(data.intents),
    capabilities: strings(data.capabilities),
    related: strings(data.related),
    requires: strings(data.requires),
    sillo: String(data.sillo ?? ""),
    packages: strings(data.packages),
    symbols: strings(data.symbols),
    probes: strings(data.probes),
    sources: strings(data.sources),
    status: String(data.status ?? "draft") as SkillStatus,
  };
}

export async function loadSkill(
  dir: string,
  origin: SkillOrigin = { kind: "builtin" },
): Promise<Skill> {
  const skillPath = path.join(dir, "SKILL.md");
  let text: string;
  try {
    text = await fs.readFile(skillPath, "utf8");
  } catch {
    throw new AgentError(`${skillPath}: not found.`);
  }
  const { data, body } = parseFrontmatter(text, skillPath);
  const files = [];
  for (const rel of await listFiles(dir)) {
    if (rel === "SKILL.md") continue;
    files.push({
      path: rel,
      content: await fs.readFile(path.join(dir, ...rel.split("/")), "utf8"),
    });
  }
  return { meta: toFrontmatter(data), body, files, dir, origin };
}

/** Load every skill directory under `root` (each must contain a SKILL.md). */
export async function loadSkills(
  root: string = builtinSkillsDir(),
  origin: SkillOrigin = { kind: "builtin" },
): Promise<Skill[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    throw new AgentError(`Skill catalog not found at ${root}.`, {
      hint: "Reinstall @sillo/agent; the package ships its skills alongside the CLI.",
    });
  }
  const skills: Skill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    skills.push(await loadSkill(path.join(root, entry.name), origin));
  }
  return skills;
}
