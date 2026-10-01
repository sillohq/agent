import type { Skill } from "../skills/schema.js";
import type { Capability, CapabilityCatalog } from "./catalog.js";
import type { Surface } from "./surface.js";

export type CoverageState = "covered" | "documented-absent" | "draft-only" | "missing" | "internal";

export interface CapabilityCoverage {
  capability: Capability;
  state: CoverageState;
  skills: string[];
}

export interface CoverageReport {
  rows: CapabilityCoverage[];
  /** Required, present capabilities: the denominator. */
  required: number;
  covered: number;
  percent: number;
  absentDocumented: number;
  absentTotal: number;
}

/**
 * Coverage against framework/capabilities.yml. The percentage counts only
 * capabilities Sillo has (`present`) and that are `required` — experimental
 * packages and deliberately-absent features are reported, never folded in.
 */
export function computeCoverage(catalog: CapabilityCatalog, skills: Skill[]): CoverageReport {
  const stable = new Map<string, string[]>();
  const draft = new Map<string, string[]>();
  for (const skill of skills) {
    const target = skill.meta.status === "stable" ? stable : draft;
    for (const cap of skill.meta.capabilities)
      target.set(cap, [...(target.get(cap) ?? []), skill.meta.name]);
  }
  const rows: CapabilityCoverage[] = catalog.capabilities.map((capability) => {
    const claimed = stable.get(capability.id) ?? [];
    let state: CoverageState;
    if (capability.status === "internal") state = "internal";
    else if (capability.status === "absent")
      state = claimed.length ? "documented-absent" : "missing";
    else if (claimed.length) state = "covered";
    else if (draft.has(capability.id)) state = "draft-only";
    else state = "missing";
    return {
      capability,
      state,
      skills: claimed.length ? claimed : (draft.get(capability.id) ?? []),
    };
  });
  const denominator = rows.filter(
    (r) => r.capability.status === "present" && r.capability.required,
  );
  const covered = denominator.filter((r) => r.state === "covered").length;
  const absent = rows.filter((r) => r.capability.status === "absent");
  return {
    rows,
    required: denominator.length,
    covered,
    percent: denominator.length ? Math.floor((covered / denominator.length) * 1000) / 10 : 100,
    absentDocumented: absent.filter((r) => r.state === "documented-absent").length,
    absentTotal: absent.length,
  };
}

export interface GapReport {
  /** Public modules in a snapshot that no capability (and no internal entry) owns. */
  unmapped: Array<{ distribution: string; module: string; symbols: number }>;
  /** Module prefixes a capability claims that no snapshot contains any more. */
  stale: Array<{ capability: string; module: string }>;
  /** Exported names never mentioned by any skill, per distribution. */
  unmentioned: Array<{ distribution: string; symbol: string }>;
  symbolTotal: number;
  symbolMentioned: number;
}

/** `x.y` owns x.y and everything below it; `x.y$` owns exactly x.y. */
export function owns(prefix: string, module: string): boolean {
  if (prefix.endsWith("$")) return module === prefix.slice(0, -1);
  return module === prefix || module.startsWith(`${prefix}.`);
}

/**
 * Compare surface snapshots with the capability inventory. A module that
 * appears in a new Sillo release and is mapped nowhere is exactly the "new
 * subsystem shipped quietly" case, so it is an error in CI.
 */
export function findGaps(
  catalog: CapabilityCatalog,
  skills: Skill[],
  surfaces: Surface[],
): GapReport {
  const prefixes = catalog.capabilities.flatMap((c) => c.modules.map((m) => ({ id: c.id, m })));
  const unmapped: GapReport["unmapped"] = [];
  const allModules = new Set<string>();
  for (const surface of surfaces) {
    for (const [module, entry] of Object.entries(surface.modules)) {
      allModules.add(module);
      if (catalog.internal.some((p) => owns(p, module))) continue;
      if (prefixes.some(({ m }) => owns(m, module))) continue;
      // A bare namespace package with nothing of its own is not a subsystem.
      if (Object.keys(entry.symbols).length === 0) continue;
      unmapped.push({
        distribution: surface.distribution,
        module,
        symbols: Object.keys(entry.symbols).length,
      });
    }
  }
  const stale: GapReport["stale"] = [];
  const snapshotted = new Set(surfaces.map((s) => s.distribution));
  for (const cap of catalog.capabilities) {
    if (cap.distribution && !snapshotted.has(cap.distribution)) continue;
    for (const m of cap.modules) {
      if (![...allModules].some((mod) => owns(m, mod)))
        stale.push({ capability: cap.id, module: m });
    }
  }

  // Symbol mentions: a coarse signal, not a gate. A name counts as mentioned
  // when it appears in a skill's symbols list or anywhere in its text.
  const corpus = skills
    .map((s) => [s.meta.symbols.join(" "), s.body, ...s.files.map((f) => f.content)].join("\n"))
    .join("\n");
  const unmentioned: GapReport["unmentioned"] = [];
  let total = 0;
  let mentioned = 0;
  for (const surface of surfaces) {
    for (const [module, entry] of Object.entries(surface.modules)) {
      // Only the package-level API: what `from <package> import X` offers.
      if (!entry.package || !entry.all) continue;
      if (catalog.internal.some((p) => owns(p, module))) continue;
      for (const name of Object.keys(entry.symbols)) {
        if (/^HTTP_\d{3}_/.test(name)) continue;
        total++;
        if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(corpus))
          mentioned++;
        else unmentioned.push({ distribution: surface.distribution, symbol: `${module}.${name}` });
      }
    }
  }
  return { unmapped, stale, unmentioned, symbolTotal: total, symbolMentioned: mentioned };
}
