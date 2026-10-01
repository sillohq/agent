import fs from "node:fs/promises";
import path from "node:path";
import { AgentError, isNodeError } from "../core/errors.js";
import { writeFileAtomic } from "../core/fs.js";
import type { HostId, Scope } from "../hosts/types.js";
import { AGENT_VERSION, PACKAGE_NAME } from "../version.js";

/**
 * The installation manifest: the complete record of what Sillo Agent owns in a
 * scope. Nothing is ever removed or overwritten unless it is listed here with
 * a hash that still matches what is on disk — that is what makes uninstall
 * safe next to files the user wrote themselves.
 *
 * Paths are stored relative to the scope root (the project root, or the home
 * directory for a global install) with `/` separators, so a manifest survives
 * the project being moved or checked out elsewhere.
 */
export const MANIFEST_SCHEMA = 1;
export const MANIFEST_DIR = ".sillo-agent";
export const MANIFEST_FILE = "manifest.json";

export interface OwnedFile {
  path: string;
  sha256: string;
  skill: string;
  /** The skill directory root this file was written under, relative. */
  location: string;
  hosts: HostId[];
}

export interface OwnedBlock {
  file: string;
  sha256: string;
  hosts: HostId[];
  /** The file did not exist before; remove it when the block goes and nothing else is left. */
  createdFile: boolean;
}

export interface Manifest {
  schema: number;
  tool: string;
  version: string;
  scope: Scope;
  hosts: HostId[];
  options: { instructions: boolean; packageSkills: boolean };
  installedAt: string;
  updatedAt: string;
  files: OwnedFile[];
  blocks: OwnedBlock[];
}

export function manifestPath(root: string): string {
  return path.join(root, MANIFEST_DIR, MANIFEST_FILE);
}

export type ManifestRead =
  | { state: "missing" }
  | { state: "ok"; manifest: Manifest }
  | { state: "corrupt"; reason: string; raw: string };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Structural validation; anything off is reported as corrupt rather than trusted. */
export function checkManifest(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return "not an object";
  const m = value as Record<string, unknown>;
  if (m.tool !== PACKAGE_NAME) return `tool is ${JSON.stringify(m.tool)}, not ${PACKAGE_NAME}`;
  if (m.schema !== MANIFEST_SCHEMA) return `unsupported schema ${JSON.stringify(m.schema)}`;
  if (m.scope !== "global" && m.scope !== "project") return "scope is missing";
  if (!isStringArray(m.hosts)) return "hosts is not a list";
  if (!Array.isArray(m.files) || !Array.isArray(m.blocks)) return "files or blocks is not a list";
  for (const f of m.files as Array<Record<string, unknown>>) {
    if (typeof f?.path !== "string" || typeof f.sha256 !== "string" || !isStringArray(f.hosts)) {
      return "a file entry is malformed";
    }
    // Global installs may own files outside HOME (CLAUDE_CONFIG_DIR, CODEX_HOME
    // and friends can point anywhere), recorded as absolute paths. Where any
    // path may point is checked again against the known locations on use.
    const absolute = f.path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(f.path);
    if ((absolute && m.scope !== "global") || f.path.split("/").includes("..")) {
      return `a file entry escapes the scope root: ${f.path}`;
    }
  }
  for (const b of m.blocks as Array<Record<string, unknown>>) {
    if (typeof b?.file !== "string" || typeof b.sha256 !== "string" || !isStringArray(b.hosts)) {
      return "a block entry is malformed";
    }
    const absolute = b.file.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(b.file);
    if ((absolute && m.scope !== "global") || b.file.split("/").includes("..")) {
      return `a block entry escapes the scope root: ${b.file}`;
    }
  }
  return undefined;
}

export async function readManifest(root: string): Promise<ManifestRead> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(root), "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return { state: "missing" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { state: "corrupt", reason: `not valid JSON (${(error as Error).message})`, raw };
  }
  const problem = checkManifest(parsed);
  if (problem) return { state: "corrupt", reason: problem, raw };
  const manifest = parsed as Manifest;
  const options: Partial<Manifest["options"]> = manifest.options ?? {};
  manifest.options = {
    instructions: options.instructions ?? true,
    packageSkills: options.packageSkills ?? false,
  };
  return { state: "ok", manifest };
}

export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const sorted: Manifest = {
    ...manifest,
    tool: PACKAGE_NAME,
    schema: MANIFEST_SCHEMA,
    files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)),
    blocks: [...manifest.blocks].sort((a, b) => a.file.localeCompare(b.file)),
  };
  await writeFileAtomic(root, manifestPath(root), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Keep a corrupt manifest for the user to inspect instead of discarding it. */
export async function quarantineManifest(root: string, raw: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(root, MANIFEST_DIR, `manifest.corrupt-${stamp}.json`);
  await writeFileAtomic(root, target, raw);
  await fs.rm(manifestPath(root), { force: true });
  return target;
}

export async function removeManifest(root: string): Promise<void> {
  await fs.rm(manifestPath(root), { force: true });
  try {
    await fs.rmdir(path.join(root, MANIFEST_DIR));
  } catch {
    // Backups or a quarantined manifest are still in there; leave it.
  }
}

export function emptyManifest(scope: Scope): Manifest {
  const now = new Date().toISOString();
  return {
    schema: MANIFEST_SCHEMA,
    tool: PACKAGE_NAME,
    version: AGENT_VERSION,
    scope,
    hosts: [],
    options: { instructions: true, packageSkills: false },
    installedAt: now,
    updatedAt: now,
    files: [],
    blocks: [],
  };
}

export function assertScopeMatches(manifest: Manifest, scope: Scope): void {
  if (manifest.scope !== scope) {
    throw new AgentError(`The manifest here records a ${manifest.scope} install, not ${scope}.`);
  }
}
