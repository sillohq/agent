import fs from "node:fs/promises";
import path from "node:path";
import { isValidRange, parseVersion } from "../core/pep440.js";
import type { CapabilityCatalog, VersionCatalog } from "../framework/catalog.js";
import { resolveSymbol, type Surface } from "../framework/surface.js";
import { GENERATED_FILES } from "./render.js";
import { BASE_SKILL, LIMITS, REQUIRED_SECTIONS, SKILL_NAME_PATTERN, type Skill } from "./schema.js";

export type Level = "error" | "warning";

export interface Diagnostic {
  level: Level;
  where: string;
  message: string;
}

export interface ValidationInput {
  skills: Skill[];
  capabilities: CapabilityCatalog;
  versions: VersionCatalog;
  /** Surface snapshots; symbol and import checks run only when present. */
  surfaces?: Surface[];
  /** Probe ids found in framework/probes; probe checks run only when present. */
  probeIds?: Set<string>;
  /** A Sillo Core checkout, for resolving `core:` and `docs:` sources. */
  coreRoot?: string;
  /** Other checkouts by distribution name, for `pkg:` sources. */
  packageRoots?: Record<string, string>;
}

const KNOWN_KEYS = new Set([
  "name",
  "title",
  "description",
  "intents",
  "capabilities",
  "related",
  "requires",
  "sillo",
  "packages",
  "symbols",
  "probes",
  "sources",
  "status",
]);

/**
 * Phrases that stand in for knowledge. A skill that says "configure X
 * according to best practices" has told the agent nothing it did not already
 * know; the point of a Sillo skill is the Sillo-specific mechanism.
 */
const VAGUE = [
  /according to best practices/i,
  /follow best practices/i,
  /as appropriate for your (use case|needs)/i,
  /configure (it|this) (properly|correctly|appropriately)\.?$/im,
  /\bTODO\b/,
  /\bTBD\b/,
  /lorem ipsum/i,
];

export function validateSkills(
  input: ValidationInput,
  rawKeys: Map<string, string[]> = new Map(),
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const names = new Set(input.skills.map((s) => s.meta.name));
  const capabilityIds = new Set(input.capabilities.capabilities.map((c) => c.id));

  const error = (where: string, message: string) => out.push({ level: "error", where, message });
  const warn = (where: string, message: string) => out.push({ level: "warning", where, message });

  if (!names.has(BASE_SKILL)) error("catalog", `the base skill "${BASE_SKILL}" is missing`);

  const seen = new Set<string>();
  for (const skill of input.skills) {
    const m = skill.meta;
    const where = m.name || path.basename(skill.dir);

    for (const key of rawKeys.get(skill.dir) ?? []) {
      if (!KNOWN_KEYS.has(key)) error(where, `unknown frontmatter key "${key}"`);
    }

    // Identity
    if (!SKILL_NAME_PATTERN.test(m.name)) error(where, `name must match ${SKILL_NAME_PATTERN}`);
    if (m.name.length > LIMITS.nameMax)
      error(where, `name is longer than ${LIMITS.nameMax} characters`);
    if (m.name !== path.basename(skill.dir))
      error(where, `name "${m.name}" does not match its directory`);
    if (seen.has(m.name)) error(where, "duplicate skill name");
    seen.add(m.name);
    if (!m.title.trim()) error(where, "title is required");

    // Discovery text
    if (
      m.description.length < LIMITS.descriptionMin ||
      m.description.length > LIMITS.descriptionMax
    ) {
      error(
        where,
        `description is ${m.description.length} characters; keep it between ${LIMITS.descriptionMin} and ${LIMITS.descriptionMax}`,
      );
    }
    if (/\n/.test(m.description)) error(where, "description must be one paragraph");
    if (m.intents.length < LIMITS.intentsMin) {
      error(
        where,
        `needs at least ${LIMITS.intentsMin} intents (natural requests that mean this skill applies)`,
      );
    }

    // Classification
    if (!m.capabilities.length) error(where, "claims no capabilities, so nothing can route to it");
    for (const cap of m.capabilities) {
      if (!capabilityIds.has(cap)) error(where, `unknown capability "${cap}"`);
    }
    for (const rel of [...m.related, ...m.requires]) {
      if (!names.has(rel)) error(where, `refers to unknown skill "${rel}"`);
      if (rel === m.name) error(where, "refers to itself");
    }
    if (!isValidRange(m.sillo))
      error(where, `"sillo" must be a version range such as ">=1.0.0 <2.0.0"`);
    if (!["stable", "draft", "deprecated"].includes(m.status))
      error(where, `unknown status "${m.status}"`);

    // Provenance
    if (m.status === "stable" && m.sources.length === 0)
      error(where, "a stable skill must cite its sources");
    for (const source of m.sources) {
      if (!/^(core|docs|pkg|probe):\S+/.test(source))
        error(where, `source "${source}" must start with core:, docs:, pkg: or probe:`);
    }
    if (input.probeIds) {
      for (const probe of m.probes) {
        if (!input.probeIds.has(probe))
          error(where, `probe "${probe}" does not exist in framework/probes`);
      }
    }
    if (input.surfaces?.length) {
      for (const symbol of m.symbols) {
        const r = resolveSymbol(input.surfaces, symbol);
        if (!r.ok) {
          if (r.reason === "no-surface") warn(where, `symbol ${symbol} is unverified: ${r.detail}`);
          else error(where, `symbol ${symbol} does not exist: ${r.detail}`);
        }
      }
    }

    // Body
    checkBody(skill, names, error, warn);
    if (input.surfaces?.length) checkImports(skill, input.surfaces, error, warn);
  }

  checkRequiresAcyclic(input.skills, error);
  checkCatalog(input, error, warn);
  return out;
}

function checkBody(
  skill: Skill,
  names: Set<string>,
  error: (w: string, m: string) => void,
  warn: (w: string, m: string) => void,
): void {
  const where = skill.meta.name;
  const body = skill.body;
  const headings = [...body.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]!);
  let cursor = -1;
  for (const section of REQUIRED_SECTIONS) {
    const index = headings.indexOf(section);
    if (index === -1) error(where, `missing "## ${section}" section`);
    else if (index < cursor) error(where, `"## ${section}" is out of order`);
    else cursor = index;
  }
  if (/^# /m.test(body.replace(/^```[\s\S]*?^```/gm, "")))
    error(where, "the body must not have an H1; the title is rendered from frontmatter");

  const lines = body.split("\n").length;
  if (lines > LIMITS.bodyMaxLines) {
    error(
      where,
      `SKILL.md body is ${lines} lines; move detail into references/ (limit ${LIMITS.bodyMaxLines})`,
    );
  }

  for (const text of [
    body,
    ...skill.files.filter((f) => f.path.endsWith(".md")).map((f) => f.content),
  ]) {
    // Claude Code runs !`command` lines before the model sees the skill. A
    // skill from this package must never execute anything on load.
    if (/(^|\s)!`[^`]+`/m.test(text))
      error(where, "contains a !`command` injection, which executes on load");
    for (const pattern of VAGUE) {
      if (pattern.test(text))
        warn(where, `vague guidance matched ${pattern}; say what Sillo actually does`);
    }
  }

  // Links to supporting files must resolve, and every file should be linked.
  const available = new Set([
    ...skill.files.map((f) => f.path),
    ...(GENERATED_FILES[skill.meta.name] ?? []),
  ]);
  const linked = new Set<string>();
  const docs = [
    { path: "SKILL.md", content: body },
    ...skill.files.filter((f) => f.path.endsWith(".md")),
  ];
  for (const doc of docs) {
    for (const m of doc.content.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]!;
      if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
      const clean = target.split("#")[0]!;
      const from = path.posix.dirname(doc.path);
      const resolved = path.posix.normalize(path.posix.join(from, clean));
      if (resolved.startsWith("../")) {
        const sibling = resolved.slice(3).split("/")[0]!;
        if (!names.has(sibling))
          error(where, `${doc.path} links to ${target}, outside any known skill`);
        continue;
      }
      if (!available.has(resolved)) error(where, `${doc.path} links to missing file ${target}`);
      linked.add(resolved);
    }
  }
  for (const file of available) {
    if (file.endsWith(".md") && !linked.has(file))
      warn(where, `${file} is never linked from SKILL.md, so agents will not find it`);
  }

  // Skill names mentioned in code spans must exist.
  for (const text of [body, ...skill.files.map((f) => f.content)]) {
    for (const m of text.matchAll(/`(sillo(?:-[a-z0-9]+)+)`/g)) {
      const mentioned = m[1]!;
      if (
        !names.has(mentioned) &&
        !/^sillo-(framework|inertia|oauth|wire|graphql|start|vise|agent)$/.test(mentioned)
      ) {
        error(where, `mentions unknown skill \`${mentioned}\``);
      }
    }
  }
}

/**
 * Every `from sillo… import …` in a Python code block must name something the
 * framework actually exports. This is the cheapest guard against the single
 * worst failure a skill can have: teaching an API that does not exist.
 */
function checkImports(
  skill: Skill,
  surfaces: Surface[],
  error: (w: string, m: string) => void,
  warn: (w: string, m: string) => void,
): void {
  const where = skill.meta.name;
  const docs = [
    { path: "SKILL.md", content: skill.body },
    ...skill.files.filter((f) => f.path.endsWith(".md")),
  ];
  const covered = (module: string) =>
    surfaces.some((s) =>
      Object.keys(s.modules).some(
        (m) => m === module.split(".")[0] || m.startsWith(`${module.split(".")[0]}.`),
      ),
    );
  for (const doc of docs) {
    for (const block of pythonBlocks(doc.content)) {
      for (const { module, names } of pythonImports(block)) {
        if (!covered(module)) continue;
        if (!names.length) {
          const r = resolveSymbol(surfaces, module);
          if (!r.ok && r.reason !== "no-surface")
            error(where, `${doc.path}: import ${module} — ${r.detail}`);
          continue;
        }
        for (const name of names) {
          const r = resolveSymbol(surfaces, `${module}.${name}`);
          if (r.ok) continue;
          // A submodule imported by name (`from sillo.auth import jwt_auth`).
          const sub = resolveSymbol(surfaces, `${module}.${name}`.replace(/\.$/, ""));
          if (sub.ok) continue;
          if (r.reason === "no-surface")
            warn(where, `${doc.path}: cannot verify ${module}.${name}`);
          else error(where, `${doc.path}: from ${module} import ${name} — ${r.detail}`);
        }
      }
    }
  }
}

export function pythonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  for (const m of markdown.matchAll(/^```(?:python|py)[^\n]*\n([\s\S]*?)^```/gm))
    blocks.push(m[1]!);
  return blocks;
}

export function pythonImports(code: string): Array<{ module: string; names: string[] }> {
  const out: Array<{ module: string; names: string[] }> = [];
  const joined = code.replace(/\(\s*([\s\S]*?)\s*\)/g, (whole, inner: string) =>
    /import/.test(whole) ? inner.replace(/\s*\n\s*/g, " ") : whole,
  );
  for (const line of joined.split("\n")) {
    const from = /^\s*from\s+([a-zA-Z_][\w.]*)\s+import\s+(.+?)\s*(#.*)?$/.exec(line);
    if (from) {
      const names = from[2]!
        .replace(/[()]/g, "")
        .split(",")
        .map((n) =>
          n
            .trim()
            .split(/\s+as\s+/)[0]!
            .trim(),
        )
        .filter((n) => n && n !== "*");
      out.push({ module: from[1]!, names });
      continue;
    }
    const plain = /^\s*import\s+([a-zA-Z_][\w.]*)(\s+as\s+\w+)?\s*$/.exec(line);
    if (plain) out.push({ module: plain[1]!, names: [] });
  }
  return out.filter((i) => /^(sillo|sillo_|warder)/.test(i.module));
}

function checkRequiresAcyclic(skills: Skill[], error: (w: string, m: string) => void): void {
  const graph = new Map(skills.map((s) => [s.meta.name, s.meta.requires]));
  const state = new Map<string, 1 | 2>();
  const visit = (name: string, trail: string[]): void => {
    if (state.get(name) === 2) return;
    if (state.get(name) === 1) {
      error(name, `"requires" forms a cycle: ${[...trail, name].join(" → ")}`);
      return;
    }
    state.set(name, 1);
    for (const next of graph.get(name) ?? []) visit(next, [...trail, name]);
    state.set(name, 2);
  };
  for (const name of graph.keys()) visit(name, []);
}

function checkCatalog(
  input: ValidationInput,
  error: (w: string, m: string) => void,
  warn: (w: string, m: string) => void,
): void {
  const ids = new Set<string>();
  for (const cap of input.capabilities.capabilities) {
    if (!/^[a-z][a-z0-9_]*$/.test(cap.id))
      error("capabilities.yml", `capability id "${cap.id}" must be snake_case`);
    if (ids.has(cap.id)) error("capabilities.yml", `duplicate capability "${cap.id}"`);
    ids.add(cap.id);
    if (!["present", "absent", "internal"].includes(cap.status)) {
      error("capabilities.yml", `capability "${cap.id}" has unknown status "${cap.status}"`);
    }
    if (cap.status === "absent" && !cap.guidance) {
      error(
        "capabilities.yml",
        `absent capability "${cap.id}" needs guidance on what to do instead`,
      );
    }
    if (cap.status === "present" && !cap.modules.length && !cap.docs.length && !cap.distribution) {
      warn(
        "capabilities.yml",
        `capability "${cap.id}" names no modules, so gap detection cannot see it`,
      );
    }
  }

  const claims = new Map<string, string[]>();
  for (const skill of input.skills) {
    if (skill.meta.status !== "stable") continue;
    for (const cap of skill.meta.capabilities)
      claims.set(cap, [...(claims.get(cap) ?? []), skill.meta.name]);
  }
  for (const cap of input.capabilities.capabilities) {
    if (cap.status === "present" && cap.required && !claims.has(cap.id)) {
      error(
        "coverage",
        `required capability "${cap.id}" (${cap.title}) is not covered by any stable skill`,
      );
    }
    if (cap.status === "absent" && !(claims.get(cap.id) ?? []).includes(BASE_SKILL)) {
      error(
        "coverage",
        `absent capability "${cap.id}" must be claimed by the base skill, which tells agents it does not exist`,
      );
    }
  }

  const names = new Set(input.skills.map((s) => s.meta.name));
  const changeIds = new Set<string>();
  for (const change of input.versions.changes) {
    if (changeIds.has(change.id)) error("versions.yml", `duplicate change id "${change.id}"`);
    changeIds.add(change.id);
    if (!parseVersion(change.version))
      error("versions.yml", `change "${change.id}" has unparseable version "${change.version}"`);
    if (!["introduced", "deprecated", "removed", "changed"].includes(change.kind)) {
      error("versions.yml", `change "${change.id}" has unknown kind "${change.kind}"`);
    }
    if (!change.skills.length)
      warn("versions.yml", `change "${change.id}" is attached to no skill`);
    for (const s of change.skills)
      if (!names.has(s)) error("versions.yml", `change "${change.id}" names unknown skill "${s}"`);
  }
  if (!isValidRange(input.versions.supported))
    error("versions.yml", "`supported` must be a version range");

  // Codex shortens every description once the list passes its budget, which is
  // exactly when routing starts to fail. Keep the whole catalog inside it.
  const listing = input.skills.reduce(
    (n, s) => n + s.meta.name.length + s.meta.description.length + 4,
    0,
  );
  if (listing > LIMITS.codexListingBudget) {
    error(
      "catalog",
      `skill listing is ${listing} characters; Codex truncates beyond ${LIMITS.codexListingBudget}`,
    );
  }
}

/** Probe ids: test function names in framework/probes, without `test_`. */
export async function discoverProbeIds(dir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => /^test_.*\.py$/.test(f));
  } catch {
    return ids;
  }
  for (const file of files) {
    const text = await fs.readFile(path.join(dir, file), "utf8");
    for (const m of text.matchAll(/^\s*(?:async\s+)?def test_(\w+)\s*\(/gm)) ids.add(m[1]!);
  }
  return ids;
}

/** Top-level frontmatter keys per skill directory, for the unknown-key check. */
export async function rawFrontmatterKeys(skills: Skill[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const skill of skills) {
    const text = await fs.readFile(path.join(skill.dir, "SKILL.md"), "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    out.set(
      skill.dir,
      [...fm.matchAll(/^([A-Za-z_][\w-]*):/gm)].map((m) => m[1]!),
    );
  }
  return out;
}
