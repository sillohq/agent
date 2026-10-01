import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { AgentError } from "../../core/errors.js";
import { exists, writeFileAtomic } from "../../core/fs.js";
import { findGaps } from "../../framework/coverage.js";
import { loadSurfaces } from "../../framework/surface.js";
import { packageRoot } from "../../skills/load.js";
import { renderSkill, type SkillFormat } from "../../skills/render.js";
import { Router } from "../../skills/route.js";
import { SKILL_NAME_PATTERN } from "../../skills/schema.js";
import {
  type Diagnostic,
  discoverProbeIds,
  rawFrontmatterKeys,
  validateSkills,
} from "../../skills/validate.js";
import { type Context, loadCatalog } from "../context.js";

/**
 * Maintainer commands. They run from a checkout of sillohq/agent and are what
 * `npm run validate`, `npm run coverage:gaps` and CI call; they are not part
 * of the everyday interface.
 */
function repoPath(...parts: string[]): string {
  return path.join(packageRoot(), ...parts);
}

export async function devValidate(
  ctx: Context,
  flags: { skillsOnly?: boolean; strict?: boolean; core?: string; json?: boolean },
): Promise<number> {
  const catalog = await loadCatalog();
  const surfaces = flags.skillsOnly ? [] : await loadSurfaces(repoPath("framework", "surface"));
  const probeIds = flags.skillsOnly
    ? undefined
    : await discoverProbeIds(repoPath("framework", "probes"));
  const input: Parameters<typeof validateSkills>[0] = { ...catalog, surfaces };
  if (probeIds) input.probeIds = probeIds;
  if (flags.core) input.coreRoot = path.resolve(ctx.envr.cwd, flags.core);
  const diagnostics = validateSkills(input, await rawFrontmatterKeys(catalog.skills));
  diagnostics.push(...(await validateSources(catalog.skills, input.coreRoot)));
  diagnostics.push(...(await validateEvals(new Set(catalog.skills.map((s) => s.meta.name)))));
  return report(
    ctx,
    diagnostics,
    flags,
    `${catalog.skills.length} skills, ${catalog.capabilities.capabilities.length} capabilities, ${surfaces.length} surface snapshot(s), ${probeIds?.size ?? 0} probes`,
  );
}

async function validateSources(
  skills: Awaited<ReturnType<typeof loadCatalog>>["skills"],
  coreRoot?: string,
): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  if (!coreRoot) return out;
  for (const skill of skills) {
    for (const source of skill.meta.sources) {
      const [kind, rest] = [
        source.slice(0, source.indexOf(":")),
        source.slice(source.indexOf(":") + 1),
      ];
      let target: string | undefined;
      if (kind === "core") target = path.join(coreRoot, rest.split("#")[0]!);
      if (kind === "docs")
        target = path.join(coreRoot, "docs", "docs", "src", "content", "docs", rest.split("#")[0]!);
      if (target && !(await exists(target)))
        out.push({
          level: "error",
          where: skill.meta.name,
          message: `source ${source} does not exist in ${coreRoot}`,
        });
    }
  }
  return out;
}

interface IntentCase {
  intent: string;
  expect: string[];
}

async function readIntentCases(): Promise<IntentCase[]> {
  const file = repoPath("evals", "intents.yml");
  if (!(await exists(file))) return [];
  const data = YAML.parse(await fs.readFile(file, "utf8")) as { cases?: IntentCase[] };
  return data.cases ?? [];
}

async function validateEvals(names: Set<string>): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  for (const c of await readIntentCases()) {
    for (const e of c.expect) {
      if (!names.has(e))
        out.push({
          level: "error",
          where: "evals/intents.yml",
          message: `"${c.intent}" expects unknown skill ${e}`,
        });
    }
  }
  return out;
}

function report(
  ctx: Context,
  diagnostics: Diagnostic[],
  flags: { strict?: boolean; json?: boolean },
  summary: string,
): number {
  const errors = diagnostics.filter((d) => d.level === "error");
  const warnings = diagnostics.filter((d) => d.level === "warning");
  if (flags.json) {
    ctx.io.stdout.write(`${JSON.stringify({ errors, warnings }, null, 2)}\n`);
  } else {
    ctx.ui.heading("Skill validation");
    ctx.ui.muted(`  ${summary}`);
    ctx.ui.line();
    for (const d of errors) ctx.ui.fail(`${d.where}: ${d.message}`);
    for (const d of warnings) ctx.ui.warn(`${d.where}: ${d.message}`);
    ctx.ui.line();
    ctx.ui.line(
      errors.length
        ? ctx.ui.paint("red", `${errors.length} error(s), ${warnings.length} warning(s)`)
        : ctx.ui.paint("green", `Valid. ${warnings.length} warning(s).`),
    );
  }
  return errors.length || (flags.strict && warnings.length) ? 1 : 0;
}

export async function devGaps(
  ctx: Context,
  flags: { surface?: string; json?: boolean; strict?: boolean },
): Promise<number> {
  const dir = path.resolve(ctx.envr.cwd, flags.surface ?? repoPath("framework", "surface"));
  const stat = await fs.stat(dir).catch(() => undefined);
  const surfaces = stat?.isFile()
    ? [JSON.parse(await fs.readFile(dir, "utf8"))]
    : await loadSurfaces(dir);
  if (!surfaces.length)
    throw new AgentError(`No surface snapshots in ${dir}.`, {
      hint: "Generate one: python framework/tools/extract_surface.py > framework/surface/sillo-framework@<version>.json",
    });
  const catalog = await loadCatalog();
  const gaps = findGaps(catalog.capabilities, catalog.skills, surfaces);
  if (flags.json) {
    ctx.io.stdout.write(`${JSON.stringify(gaps, null, 2)}\n`);
  } else {
    const ui = ctx.ui;
    ui.heading("Framework coverage gaps");
    ui.muted(`  ${surfaces.map((s) => `${s.distribution} ${s.version}`).join(", ")}`);
    ui.section("Public modules no capability owns");
    if (!gaps.unmapped.length) ui.ok("none — every public module maps to a capability");
    for (const g of gaps.unmapped)
      ui.fail(g.module, `${g.symbols} public names (${g.distribution})`);
    ui.section("Capability modules missing from the snapshot");
    if (!gaps.stale.length) ui.ok("none");
    for (const g of gaps.stale)
      ui.warn(`${g.capability}: ${g.module}`, "renamed or removed upstream?");
    ui.section("Package-level names no skill mentions");
    const pct = gaps.symbolTotal
      ? Math.round((gaps.symbolMentioned / gaps.symbolTotal) * 100)
      : 100;
    ui.info(
      `${gaps.symbolMentioned}/${gaps.symbolTotal} mentioned (${pct}%)`,
      "informational; not every exported name needs teaching",
    );
    for (const u of gaps.unmentioned.slice(0, 40)) ui.muted(`    ${u.symbol}`);
    if (gaps.unmentioned.length > 40)
      ui.muted(`    … ${gaps.unmentioned.length - 40} more (--json for all)`);
  }
  return gaps.unmapped.length || (flags.strict && gaps.stale.length) ? 1 : 0;
}

export async function devEval(
  ctx: Context,
  flags: { json?: boolean; k?: string },
): Promise<number> {
  const catalog = await loadCatalog();
  const router = new Router(catalog.skills.filter((s) => s.meta.status !== "draft"));
  const cases = await readIntentCases();
  const k = Number(flags.k ?? 5);
  const results = cases.map((c) => {
    const ranked = router.rank(c.intent, k).map((h) => h.skill);
    const composed = router.compose(c.intent, k, 2).map((h) => h.skill);
    const found = c.expect.filter((e) => ranked.includes(e));
    const reachable = c.expect.filter((e) => composed.includes(e));
    return {
      ...c,
      ranked,
      composed,
      discovered: found.length === c.expect.length,
      composable: reachable.length === c.expect.length,
      missing: c.expect.filter((e) => !composed.includes(e)),
    };
  });
  const discovered = results.filter((r) => r.discovered).length;
  const composable = results.filter((r) => r.composable).length;
  if (flags.json) {
    ctx.io.stdout.write(
      `${JSON.stringify({ k, discovered, composable, total: results.length, results }, null, 2)}\n`,
    );
  } else {
    const ui = ctx.ui;
    ui.heading("Skill routing evaluation");
    ui.muted(
      `  Lexical proxy for host routing: expected skills must rank in the top ${k}, or be reachable through a top hit's related skills.`,
    );
    ui.line();
    for (const r of results) {
      if (r.discovered) ui.ok(r.intent, r.expect.join(" + "));
      else if (r.composable)
        ui.warn(
          r.intent,
          `${r.expect.join(" + ")} (via related: ${r.expect.filter((e) => !r.ranked.includes(e)).join(", ")})`,
        );
      else ui.fail(r.intent, `missing ${r.missing.join(", ")}; got ${r.ranked.join(", ")}`);
    }
    ui.line();
    ui.line(
      `${discovered}/${results.length} fully ranked in top ${k}; ${composable}/${results.length} reachable with composition.`,
    );
  }
  return composable === results.length ? 0 : 1;
}

export async function devRender(
  ctx: Context,
  flags: { out?: string; format?: string },
): Promise<number> {
  const out = path.resolve(ctx.envr.cwd, flags.out ?? ".render");
  const catalog = await loadCatalog();
  const formats: SkillFormat[] = flags.format
    ? [flags.format as SkillFormat]
    : ["claude", "agents"];
  for (const format of formats) {
    for (const skill of catalog.skills) {
      for (const file of renderSkill(skill, format, { versions: catalog.versions })) {
        await writeFileAtomic(
          out,
          path.join(out, format, skill.meta.name, ...file.path.split("/")),
          file.content,
        );
      }
    }
  }
  ctx.ui.ok(`Rendered ${catalog.skills.length} skills × ${formats.length} format(s)`, out);
  return 0;
}

const TEMPLATE = (name: string, title: string) => `---
name: ${name}
title: ${title}
description: >-
  One or two sentences: what this Sillo capability is and when an agent should
  load this skill. Name the concrete things a developer would ask for.
intents:
  - a request a developer would actually type
  - another way of asking for the same thing
  - a third, phrased around the problem rather than the feature
capabilities: []
related: []
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols: []
probes: []
sources: []
status: draft
---

## When

Which developer requests mean this skill applies, and which neighbouring
skill to use instead when it does not.

## Inspect first

What to read in the project before changing anything.

## How

The Sillo mechanism: imports, calls, configuration, CLI commands. Every import
must exist in the surface snapshot; \`npm run validate\` checks.

## Compose

How this combines with other skills, by name (\`sillo-…\`).

## Verify

How the agent proves the change works: a test, a command, a request.

## Avoid

Mistakes that produce code which looks right and silently does not work.
`;

export async function devNewSkill(
  ctx: Context,
  args: string[],
  flags: { title?: string },
): Promise<number> {
  const raw = args[0];
  if (!raw) throw new AgentError("Name the skill: npm run skill:new -- payments", { exitCode: 2 });
  const name = raw.startsWith("sillo-") ? raw : `sillo-${raw}`;
  if (!SKILL_NAME_PATTERN.test(name))
    throw new AgentError(`"${name}" is not a valid skill name (${SKILL_NAME_PATTERN}).`, {
      exitCode: 2,
    });
  const dir = repoPath("skills", name);
  if (await exists(dir)) throw new AgentError(`${name} already exists.`, { exitCode: 2 });
  const title =
    flags.title ??
    name
      .replace(/^sillo-/, "")
      .replace(/-/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase());
  await writeFileAtomic(repoPath("skills"), path.join(dir, "SKILL.md"), TEMPLATE(name, title));
  ctx.ui.ok(`Created skills/${name}/SKILL.md`, "status: draft");
  ctx.ui.line();
  ctx.ui.line("Next:");
  ctx.ui.line(
    "  1. Map it to capabilities in framework/capabilities.yml (add one if Sillo grew a subsystem).",
  );
  ctx.ui.line(
    "  2. Write the sections from the installed source, not from memory; cite sources and symbols.",
  );
  ctx.ui.line("  3. Add a probe in framework/probes for any behaviour that is easy to get wrong.");
  ctx.ui.line(
    "  4. Add intents to evals/intents.yml, then: npm run validate && npm run eval:routing",
  );
  ctx.ui.line("  5. Set status: stable.");
  return 0;
}
