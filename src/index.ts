/**
 * @sillo/agent — programmatic API.
 *
 * The CLI (`sillo-agent`) is the normal interface; this module exposes the
 * same building blocks for tooling that wants to embed them: project
 * detection, the skill catalog, host adapters, planning and reconciliation.
 */

export { main } from "./cli/main.js";
export { AgentError } from "./core/errors.js";
export { currentEnvironment, type Environment } from "./core/paths.js";
export { compareVersions, parseVersion, satisfies } from "./core/pep440.js";
export {
  type Capability,
  type CapabilityCatalog,
  loadCapabilities,
  loadVersions,
  type VersionCatalog,
} from "./framework/catalog.js";
export {
  type CoverageReport,
  computeCoverage,
  findGaps,
  type GapReport,
} from "./framework/coverage.js";
export { loadSurfaces, resolveSymbol, type Surface } from "./framework/surface.js";
export { HOSTS, parseHost } from "./hosts/index.js";
export type { HostAdapter, HostId, Scope } from "./hosts/types.js";
export { type Manifest, readManifest } from "./install/manifest.js";
export { buildPlan, type Plan, planLocations } from "./install/plan.js";
export { type ReconcileResult, reconcile } from "./install/reconcile.js";
export { detectProject, findProjectRoot, type ProjectInfo } from "./project/detect.js";
export { builtinSkillsDir, loadSkill, loadSkills } from "./skills/load.js";
export { renderSkill, renderSkillMarkdown, type SkillFormat } from "./skills/render.js";
export { Router } from "./skills/route.js";
export type { Skill, SkillFrontmatter } from "./skills/schema.js";
export { type Diagnostic, validateSkills } from "./skills/validate.js";
export { AGENT_VERSION, PACKAGE_NAME } from "./version.js";
