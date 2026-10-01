import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { AgentError } from "../core/errors.js";
import { packageRoot } from "../skills/load.js";

/**
 * framework/capabilities.yml: the maintained inventory of Sillo's public
 * surface. It is the denominator of coverage — a capability is either
 * `present` (it must be taught by a skill), `absent` (Sillo deliberately does
 * not have it, and the base skill must say so, so agents stop inventing it) or
 * `internal` (public by accident; no guidance owed).
 */
export type CapabilityStatus = "present" | "absent" | "internal";

export interface Capability {
  id: string;
  title: string;
  area: string;
  status: CapabilityStatus;
  /** Counted in the coverage percentage. Experimental packages are not. */
  required: boolean;
  /** Python modules (prefix match) this capability owns in the surface snapshot. */
  modules: string[];
  /** The distribution providing it, when it is not sillo-framework. */
  distribution?: string;
  docs: string[];
  /** For `absent`: what to do instead. */
  guidance?: string;
  since?: string;
}

export interface CapabilityCatalog {
  framework: string;
  tracks: string;
  capabilities: Capability[];
  /** Modules that are public by name but carry no capability of their own. */
  internal: string[];
}

export type ChangeKind = "introduced" | "deprecated" | "removed" | "changed";

export interface ApiChange {
  id: string;
  api: string;
  kind: ChangeKind;
  /** The version the change landed in. */
  version: string;
  summary: string;
  replacement?: string;
  /** Skills that must mention this change in their version notes. */
  skills: string[];
}

export interface VersionCatalog {
  /** The Sillo range this release of the agent is written for. */
  supported: string;
  /** Versions a project may be on that the skills explicitly do not cover. */
  legacy: Array<{ range: string; note: string }>;
  changes: ApiChange[];
}

function frameworkDir(): string {
  return path.join(packageRoot(), "framework");
}

async function readYaml(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    throw new AgentError(`Missing ${file}.`);
  }
  try {
    return YAML.parse(text, { strict: true, uniqueKeys: true });
  } catch (error) {
    throw new AgentError(`${file} is not valid YAML: ${(error as Error).message}`);
  }
}

function asArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

export async function loadCapabilities(
  file = path.join(frameworkDir(), "capabilities.yml"),
): Promise<CapabilityCatalog> {
  const raw = (await readYaml(file)) as Record<string, unknown>;
  const list = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  const capabilities: Capability[] = list.map((item: Record<string, unknown>) => {
    const status = String(item.status ?? "present") as CapabilityStatus;
    const capability: Capability = {
      id: String(item.id ?? ""),
      title: String(item.title ?? item.id ?? ""),
      area: String(item.area ?? "other"),
      status,
      required: item.required === undefined ? status !== "internal" : Boolean(item.required),
      modules: asArray(item.modules),
      docs: asArray(item.docs),
    };
    if (item.distribution !== undefined) capability.distribution = String(item.distribution);
    if (item.guidance !== undefined) capability.guidance = String(item.guidance).trim();
    if (item.since !== undefined) capability.since = String(item.since);
    return capability;
  });
  return {
    framework: String(raw.framework ?? "sillo"),
    tracks: String(raw.tracks ?? ""),
    capabilities,
    internal: asArray(raw.internal),
  };
}

export async function loadVersions(
  file = path.join(frameworkDir(), "versions.yml"),
): Promise<VersionCatalog> {
  const raw = (await readYaml(file)) as Record<string, unknown>;
  const changes = (Array.isArray(raw.changes) ? raw.changes : []).map(
    (item: Record<string, unknown>): ApiChange => {
      const change: ApiChange = {
        id: String(item.id ?? ""),
        api: String(item.api ?? ""),
        kind: String(item.kind ?? "changed") as ChangeKind,
        version: String(item.version ?? ""),
        summary: String(item.summary ?? "").trim(),
        skills: asArray(item.skills),
      };
      if (item.replacement !== undefined) change.replacement = String(item.replacement);
      return change;
    },
  );
  const legacy = (Array.isArray(raw.legacy) ? raw.legacy : []).map(
    (item: Record<string, unknown>) => ({
      range: String(item.range ?? ""),
      note: String(item.note ?? "").trim(),
    }),
  );
  return { supported: String(raw.supported ?? ""), legacy, changes };
}
