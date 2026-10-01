import fs from "node:fs/promises";
import path from "node:path";

/**
 * A surface snapshot, as written by framework/tools/extract_surface.py: every
 * public module of an installed distribution, its exported names, their
 * signatures and (for classes) their public members.
 */
export interface SurfaceSymbol {
  kind: string;
  signature?: string;
  members?: string[];
}

export interface Surface {
  distribution: string;
  version: string;
  modules: Record<
    string,
    { package: boolean; all: boolean; symbols: Record<string, SurfaceSymbol> }
  >;
  cli: Array<{ name: string; help?: string; requires?: string }>;
  unimportable?: Record<string, string>;
}

export async function loadSurfaces(dir: string): Promise<Surface[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: Surface[] = [];
  for (const name of names) {
    const data = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Surface;
    out.push({
      ...data,
      cli: data.cli ?? [],
      distribution: data.distribution ?? name.split("@")[0]!,
    });
  }
  return out;
}

export type SymbolResolution =
  | { ok: true; surface: Surface; module: string; name?: string; member?: string }
  | { ok: false; reason: "no-surface" | "no-module" | "no-symbol" | "no-member"; detail: string };

/**
 * Resolve `a.b.c.Name.member` against the snapshots: the longest dotted prefix
 * that is a module, then an exported name, then optionally one class member.
 */
export function resolveSymbol(surfaces: Surface[], symbol: string): SymbolResolution {
  const parts = symbol.split(".");
  let sawTopLevel = false;
  for (const surface of surfaces) {
    for (let i = parts.length; i > 0; i--) {
      const module = parts.slice(0, i).join(".");
      const entry = surface.modules[module];
      if (!entry) continue;
      sawTopLevel = true;
      const rest = parts.slice(i);
      if (rest.length === 0) return { ok: true, surface, module };
      const name = rest[0]!;
      const sym = entry.symbols[name];
      if (!sym) {
        return { ok: false, reason: "no-symbol", detail: `${module} has no public name ${name}` };
      }
      if (rest.length === 1) return { ok: true, surface, module, name };
      if (rest.length === 2 && sym.members?.includes(rest[1]!)) {
        return { ok: true, surface, module, name, member: rest[1]! };
      }
      return {
        ok: false,
        reason: "no-member",
        detail: `${module}.${name} has no public member ${rest.slice(1).join(".")}`,
      };
    }
    if (surface.modules[parts[0]!]) sawTopLevel = true;
  }
  return sawTopLevel
    ? { ok: false, reason: "no-module", detail: `no module of ${symbol} is in the surface` }
    : { ok: false, reason: "no-surface", detail: `no surface snapshot covers ${parts[0]}` };
}

export function symbolSignature(surfaces: Surface[], symbol: string): string | undefined {
  const r = resolveSymbol(surfaces, symbol);
  if (!r.ok || !r.name) return undefined;
  return r.surface.modules[r.module]!.symbols[r.name]!.signature;
}
