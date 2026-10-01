import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { exists, isDirectory, readText } from "../core/fs.js";
import { compareVersions, parseVersion } from "../core/pep440.js";

/**
 * Everything worth knowing about whether a directory is a Sillo project, and
 * which Sillo it is — assembled from several independent signals so that no
 * single missing file makes a real project look like something else.
 *
 * Nothing here reads `.env` files or anything else that commonly holds
 * secrets: only dependency metadata, lock files, installed package metadata
 * and Python import lines.
 */

export const FRAMEWORK_DISTRIBUTION = "sillo-framework";

/** Official packages that extend Sillo, by distribution name. */
export const OFFICIAL_PACKAGES = [
  "sillo-inertia",
  "sillo-oauth",
  "sillo-wire",
  "sillo-graphql",
  "warder",
  "sillo-start",
  "sillo-vise",
] as const;

export type Confidence = "high" | "medium" | "low" | "none";

export interface VersionEvidence {
  version: string;
  source: string;
}

export interface ProjectInfo {
  root: string;
  isSillo: boolean;
  confidence: Confidence;
  evidence: string[];
  /** The requirement as written, e.g. `sillo-framework[record]>=1.0.0`. */
  declared?: { spec: string; source: string };
  /** What a lock file pins. */
  locked?: VersionEvidence;
  /** What is actually installed in the project's virtual environment. */
  installed?: VersionEvidence;
  /** Best available answer: installed, then locked, then an exact pin. */
  version?: VersionEvidence;
  extras: string[];
  packages: Array<{ name: string; version?: string; source: string }>;
  /** `[tool.sillo] app`, the import string the CLI uses. */
  app?: string;
  packageManager?: "uv" | "poetry" | "pdm" | "pipenv" | "pip";
  requiresPython?: string;
  tests?: "pytest" | "unittest";
  /** Subsystems the code visibly uses, from its imports. */
  uses: string[];
  virtualenv?: string;
}

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".venv",
  "venv",
  "env",
  ".env",
  "node_modules",
  "__pycache__",
  ".tox",
  ".nox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "site-packages",
]);

const MAX_PY_FILES = 400;
const MAX_PY_BYTES = 256 * 1024;

/** Normalise a distribution name per PEP 503. */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

interface Requirement {
  name: string;
  extras: string[];
  spec: string;
  raw: string;
}

/** Parse one PEP 508 requirement line, loosely: name[extras] specifier ; markers. */
export function parseRequirement(line: string): Requirement | undefined {
  const text = line.split("#")[0]!.split(";")[0]!.trim();
  if (!text || text.startsWith("-")) return undefined;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*(.*)$/.exec(text);
  if (!m) return undefined;
  return {
    name: normaliseName(m[1]!),
    extras: (m[2] ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean),
    spec: m[3]!.replace(/^\(|\)$/g, "").trim(),
    raw: text,
  };
}

/** The exact version an `==X` pin names, if the requirement is pinned. */
function exactPin(spec: string): string | undefined {
  const m = /^===?\s*([^\s,*]+)$/.exec(spec.trim());
  return m && parseVersion(m[1]!) ? m[1] : undefined;
}

async function readToml(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file);
  if (text === undefined) return undefined;
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function get(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const key of keys) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function requirementsFromPyproject(py: Record<string, unknown>): Requirement[] {
  const lines: string[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) for (const item of v) if (typeof item === "string") lines.push(item);
  };
  push(get(py, "project", "dependencies"));
  const optional = get(py, "project", "optional-dependencies");
  if (optional && typeof optional === "object") for (const v of Object.values(optional)) push(v);
  const groups = get(py, "dependency-groups");
  if (groups && typeof groups === "object") for (const v of Object.values(groups)) push(v);
  push(get(py, "tool", "uv", "dev-dependencies"));
  const reqs = lines.map(parseRequirement).filter((r): r is Requirement => Boolean(r));

  // Poetry: [tool.poetry.dependencies] name = "^1.0" | { version = "…", extras = […] }
  for (const table of [
    get(py, "tool", "poetry", "dependencies"),
    get(py, "tool", "poetry", "group"),
  ]) {
    if (!table || typeof table !== "object") continue;
    const entries = Object.entries(table as Record<string, unknown>);
    for (const [name, value] of entries) {
      if (name === "python") continue;
      if (value && typeof value === "object" && "dependencies" in (value as object)) {
        for (const [n, v] of Object.entries(
          (value as { dependencies: Record<string, unknown> }).dependencies,
        )) {
          reqs.push(poetryRequirement(n, v));
        }
        continue;
      }
      reqs.push(poetryRequirement(name, value));
    }
  }
  return reqs;
}

function poetryRequirement(name: string, value: unknown): Requirement {
  if (typeof value === "string")
    return { name: normaliseName(name), extras: [], spec: value, raw: `${name} ${value}` };
  const v = (value ?? {}) as { version?: string; extras?: string[] };
  return {
    name: normaliseName(name),
    extras: Array.isArray(v.extras) ? v.extras.map(String) : [],
    spec: v.version ?? "",
    raw: `${name} ${v.version ?? ""}`.trim(),
  };
}

async function requirementsFiles(
  root: string,
): Promise<Array<{ file: string; reqs: Requirement[] }>> {
  const out: Array<{ file: string; reqs: Requirement[] }> = [];
  const candidates: string[] = [];
  try {
    for (const name of await fs.readdir(root)) {
      if (/^requirements.*\.(txt|in)$/i.test(name)) candidates.push(path.join(root, name));
    }
  } catch {
    return out;
  }
  const dir = path.join(root, "requirements");
  if (await isDirectory(dir)) {
    for (const name of await fs.readdir(dir))
      if (/\.(txt|in)$/i.test(name)) candidates.push(path.join(dir, name));
  }
  for (const file of candidates.sort()) {
    const text = (await readText(file)) ?? "";
    const reqs = text
      .split(/\r?\n/)
      .map(parseRequirement)
      .filter((r): r is Requirement => Boolean(r));
    out.push({ file, reqs });
  }
  return out;
}

async function lockedVersions(
  root: string,
): Promise<{ manager?: ProjectInfo["packageManager"]; versions: Map<string, VersionEvidence> }> {
  const versions = new Map<string, VersionEvidence>();
  let manager: ProjectInfo["packageManager"];
  const tomlLocks: Array<[string, ProjectInfo["packageManager"]]> = [
    ["uv.lock", "uv"],
    ["poetry.lock", "poetry"],
    ["pdm.lock", "pdm"],
  ];
  for (const [name, pm] of tomlLocks) {
    const data = await readToml(path.join(root, name));
    if (!data) continue;
    manager ??= pm;
    const packages = Array.isArray(data.package) ? data.package : [];
    for (const pkg of packages as Array<{ name?: string; version?: string }>) {
      if (pkg.name && pkg.version && !versions.has(normaliseName(pkg.name))) {
        versions.set(normaliseName(pkg.name), { version: pkg.version, source: name });
      }
    }
  }
  const pipfileLock = await readText(path.join(root, "Pipfile.lock"));
  if (pipfileLock) {
    manager ??= "pipenv";
    try {
      const data = JSON.parse(pipfileLock) as Record<string, Record<string, { version?: string }>>;
      for (const section of ["default", "develop"]) {
        for (const [name, entry] of Object.entries(data[section] ?? {})) {
          const v = entry.version?.replace(/^==/, "");
          if (v && !versions.has(normaliseName(name)))
            versions.set(normaliseName(name), { version: v, source: "Pipfile.lock" });
        }
      }
    } catch {
      // A corrupt lock file is not our problem to report here.
    }
  }
  return { manager, versions };
}

/**
 * Installed distributions in the project's own virtual environment, from
 * `*.dist-info` directory names — authoritative for what will actually run.
 */
async function installedVersions(
  root: string,
): Promise<{ venv?: string; versions: Map<string, VersionEvidence> }> {
  const versions = new Map<string, VersionEvidence>();
  for (const venvName of [".venv", "venv", "env"]) {
    const venv = path.join(root, venvName);
    if (!(await exists(path.join(venv, "pyvenv.cfg")))) continue;
    const siteDirs: string[] = [];
    const winSite = path.join(venv, "Lib", "site-packages");
    if (await isDirectory(winSite)) siteDirs.push(winSite);
    const lib = path.join(venv, "lib");
    if (await isDirectory(lib)) {
      for (const entry of await fs.readdir(lib)) {
        const site = path.join(lib, entry, "site-packages");
        if (/^python\d/.test(entry) && (await isDirectory(site))) siteDirs.push(site);
      }
    }
    for (const site of siteDirs) {
      for (const entry of await fs.readdir(site)) {
        const m = /^(.+?)-([^-]+)\.dist-info$/.exec(entry);
        if (!m) continue;
        const name = normaliseName(m[1]!);
        if (!versions.has(name)) {
          versions.set(name, {
            version: m[2]!,
            source: path.relative(root, path.join(site, entry)),
          });
        }
      }
    }
    return { venv: venvName, versions };
  }
  return { versions };
}

const USE_PATTERNS: Array<[string, RegExp]> = [
  ["record", /\bsillo\.record\b|setup_record|\bRecord\(/],
  ["auth", /\bsillo\.auth\b|useAuth/],
  ["sessions", /\bsillo\.session\b/],
  ["work", /\bsillo\.work\b/],
  ["events", /\bsillo\.events\b/],
  ["cache", /\bsillo\.cache\b/],
  ["mail", /\bsillo\.mail\b/],
  ["storage", /\bsillo\.storage\b/],
  ["websockets", /ws_route|WebSocketContext|\bsillo\.websockets\b/],
  ["security", /\bsillo\.security\b/],
  ["openapi", /\bsillo\.openapi\b/],
  ["testing", /\bsillo\.testclient\b/],
  ["console", /\bsillo\.console\b/],
  ["inertia", /\bsillo_inertia\b|\bsillo\.inertia\b/],
  ["oauth", /\bsillo_oauth\b|\bsillo\.oauth\b/],
  ["wire", /\bsillo\.wire\b|\bsillo_wire\b/],
  ["graphql", /\bsillo\.graphql\b/],
  ["admin", /\bwarder\b/],
];

async function scanImports(
  root: string,
): Promise<{ importsSillo: string[]; uses: Set<string>; tests: boolean }> {
  const importsSillo: string[] = [];
  const uses = new Set<string>();
  let tests = false;
  let count = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (count >= MAX_PY_FILES || depth > 6) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_PY_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (entry.name === "tests" || entry.name === "test") tests = true;
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        count++;
        if (/^test_.*\.py$|_test\.py$/.test(entry.name)) tests = true;
        const stat = await fs.stat(full);
        if (stat.size > MAX_PY_BYTES) continue;
        const text = await fs.readFile(full, "utf8");
        if (/^\s*(from\s+sillo(\.[\w.]+)?\s+import|import\s+sillo\b)/m.test(text)) {
          importsSillo.push(path.relative(root, full));
        }
        for (const [name, pattern] of USE_PATTERNS) if (pattern.test(text)) uses.add(name);
      }
    }
  }
  await walk(root, 0);
  return { importsSillo, uses, tests };
}

export async function detectProject(start: string): Promise<ProjectInfo> {
  const root = await findProjectRoot(start);
  const info: ProjectInfo = {
    root,
    isSillo: false,
    confidence: "none",
    evidence: [],
    extras: [],
    packages: [],
    uses: [],
  };
  let score = 0;

  const pyproject = await readToml(path.join(root, "pyproject.toml"));
  const declared: Array<{ req: Requirement; source: string }> = [];
  if (pyproject) {
    for (const req of requirementsFromPyproject(pyproject))
      declared.push({ req, source: "pyproject.toml" });
    const app = get(pyproject, "tool", "sillo", "app");
    if (typeof app === "string") {
      info.app = app;
      info.evidence.push(`[tool.sillo] app = "${app}" in pyproject.toml`);
      score += 3;
    }
    const rp = get(pyproject, "project", "requires-python");
    if (typeof rp === "string") info.requiresPython = rp;
    if (get(pyproject, "tool", "pytest")) info.tests = "pytest";
    if (get(pyproject, "tool", "poetry")) info.packageManager = "poetry";
  }
  for (const { file, reqs } of await requirementsFiles(root)) {
    for (const req of reqs) declared.push({ req, source: path.relative(root, file) });
    info.packageManager ??= "pip";
  }

  const framework = declared.find((d) => d.req.name === FRAMEWORK_DISTRIBUTION);
  if (framework) {
    info.declared = { spec: framework.req.raw, source: framework.source };
    info.extras = framework.req.extras;
    info.evidence.push(`${framework.req.raw} in ${framework.source}`);
    score += 4;
  }

  const locks = await lockedVersions(root);
  info.packageManager = locks.manager ?? info.packageManager;
  const lockedFramework = locks.versions.get(FRAMEWORK_DISTRIBUTION);
  if (lockedFramework) {
    info.locked = lockedFramework;
    info.evidence.push(
      `${FRAMEWORK_DISTRIBUTION} ${lockedFramework.version} locked in ${lockedFramework.source}`,
    );
    score += 3;
  }

  const installed = await installedVersions(root);
  if (installed.venv) info.virtualenv = installed.venv;
  const installedFramework = installed.versions.get(FRAMEWORK_DISTRIBUTION);
  if (installedFramework) {
    info.installed = installedFramework;
    info.evidence.push(
      `${FRAMEWORK_DISTRIBUTION} ${installedFramework.version} installed in ${installed.venv}`,
    );
    score += 3;
  }

  for (const name of OFFICIAL_PACKAGES) {
    const inst = installed.versions.get(name);
    const lock = locks.versions.get(name);
    const decl = declared.find((d) => d.req.name === name);
    if (inst || lock || decl) {
      const pkg: { name: string; version?: string; source: string } = {
        name,
        source: inst ? "installed" : lock ? lock.source : decl!.source,
      };
      const version = inst?.version ?? lock?.version;
      if (version) pkg.version = version;
      info.packages.push(pkg);
    }
  }
  if (info.packages.some((p) => p.name !== "sillo-start")) score += 1;

  const scan = await scanImports(root);
  if (scan.importsSillo.length) {
    const shown = scan.importsSillo.slice(0, 3).join(", ");
    info.evidence.push(
      `imports sillo in ${scan.importsSillo.length} file(s): ${shown}${scan.importsSillo.length > 3 ? ", …" : ""}`,
    );
    score += scan.importsSillo.length >= 2 ? 3 : 2;
  }
  info.uses = [...scan.uses].sort();
  if (!info.tests && scan.tests) info.tests = "pytest";

  const pinned = framework ? exactPin(framework.req.spec) : undefined;
  info.version =
    info.installed ??
    info.locked ??
    (pinned ? { version: pinned, source: `${info.declared!.source} (pinned)` } : undefined);

  info.isSillo = score >= 2;
  info.confidence = score >= 6 ? "high" : score >= 4 ? "medium" : score >= 2 ? "low" : "none";
  return info;
}

/**
 * The nearest ancestor that looks like a Python project root, or `start`.
 * Stops at a VCS root so a stray pyproject.toml above the repository is never
 * mistaken for this one.
 */
export async function findProjectRoot(start: string): Promise<string> {
  let dir = path.resolve(start);
  for (;;) {
    for (const marker of [
      "pyproject.toml",
      "uv.lock",
      "poetry.lock",
      "requirements.txt",
      "setup.py",
      "setup.cfg",
    ]) {
      if (await exists(path.join(dir, marker))) return dir;
    }
    if (await exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/** The newest of several versions, for reports. */
export function newest(versions: string[]): string | undefined {
  const parsed = versions.map((v) => ({ v, p: parseVersion(v) })).filter((x) => x.p);
  parsed.sort((a, b) => compareVersions(b.p!, a.p!));
  return parsed[0]?.v;
}
