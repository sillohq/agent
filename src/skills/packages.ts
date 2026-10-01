import fs from "node:fs/promises";
import path from "node:path";
import { isDirectory } from "../core/fs.js";
import { loadSkill } from "./load.js";
import type { Skill } from "./schema.js";

/**
 * Skills shipped inside Python packages.
 *
 * A package that extends Sillo can teach coding agents how to use it by
 * shipping canonical skills in a `sillo_skills/` directory inside its import
 * package:
 *
 *     acme_payments/
 *       __init__.py
 *       sillo_skills/
 *         sillo-acme-payments/
 *           SKILL.md
 *
 * They are only installed with `--with-package-skills`, only from the
 * project's own virtual environment, and validated like bundled skills. A
 * skill is instructions to a powerful agent; picking them up silently from
 * whatever happens to be installed would be the wrong default.
 */
export interface PackageSkillSource {
  distribution: string;
  dir: string;
}

async function siteDirs(projectRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const venv of [".venv", "venv", "env"]) {
    const base = path.join(projectRoot, venv);
    const win = path.join(base, "Lib", "site-packages");
    if (await isDirectory(win)) out.push(win);
    const lib = path.join(base, "lib");
    if (!(await isDirectory(lib))) continue;
    for (const entry of await fs.readdir(lib)) {
      const site = path.join(lib, entry, "site-packages");
      if (/^python\d/.test(entry) && (await isDirectory(site))) out.push(site);
    }
  }
  return out;
}

export async function findPackageSkills(projectRoot: string): Promise<PackageSkillSource[]> {
  const sources: PackageSkillSource[] = [];
  for (const site of await siteDirs(projectRoot)) {
    for (const pkg of await fs.readdir(site)) {
      const skillsDir = path.join(site, pkg, "sillo_skills");
      if (await isDirectory(skillsDir)) sources.push({ distribution: pkg, dir: skillsDir });
    }
  }
  return sources;
}

export async function loadPackageSkills(
  projectRoot: string,
  builtinNames: Set<string>,
): Promise<{ skills: Skill[]; problems: string[] }> {
  const skills: Skill[] = [];
  const problems: string[] = [];
  for (const source of await findPackageSkills(projectRoot)) {
    for (const entry of await fs.readdir(source.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(source.dir, entry.name);
      try {
        const skill = await loadSkill(dir, {
          kind: "package",
          distribution: source.distribution,
          path: dir,
        });
        if (builtinNames.has(skill.meta.name)) {
          problems.push(
            `${source.distribution}: ${skill.meta.name} would replace a bundled Sillo skill; skipped`,
          );
          continue;
        }
        skills.push(skill);
      } catch (error) {
        problems.push(`${source.distribution}: ${(error as Error).message}`);
      }
    }
  }
  return { skills, problems };
}
