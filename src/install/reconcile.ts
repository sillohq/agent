import fs from "node:fs/promises";
import path from "node:path";
import { AgentError } from "../core/errors.js";
import {
  exists,
  listFiles,
  pruneEmptyDirs,
  readText,
  removeOwnedFile,
  sha256,
  writeFileAtomic,
} from "../core/fs.js";
import { isWithin } from "../core/paths.js";
import type { HostContext, HostId } from "../hosts/types.js";
import { GENERATED_MARKER } from "../skills/render.js";
import { AGENT_VERSION } from "../version.js";
import { findBlock, importsAgentsMd, removeBlock, upsertBlock } from "./instructions.js";
import {
  emptyManifest,
  MANIFEST_DIR,
  type Manifest,
  type OwnedBlock,
  type OwnedFile,
  quarantineManifest,
  readManifest,
  removeManifest,
  writeManifest,
} from "./manifest.js";
import { allowedRoots, manifestKey, owningSkillDir, type Plan } from "./plan.js";

export type Action =
  | "created"
  | "updated"
  | "unchanged"
  | "adopted"
  | "restored"
  | "kept-modified"
  | "overwritten"
  | "conflict"
  | "removed"
  | "left-modified"
  | "skipped"
  | "refused";

export interface Change {
  kind: "file" | "block";
  path: string;
  action: Action;
  skill?: string;
  hosts: HostId[];
  note?: string;
}

export interface ReconcileOptions {
  force?: boolean;
  dryRun?: boolean;
}

export interface ReconcileResult {
  changes: Change[];
  manifest: Manifest | undefined;
  /** Set when a corrupt manifest was moved aside and ownership rebuilt. */
  quarantined?: { path: string; reason: string };
  backups: string[];
}

interface Previous {
  files: Map<string, OwnedFile & { abs: string }>;
  blocks: Map<string, OwnedBlock & { abs: string }>;
  manifest: Manifest | undefined;
}

function resolveKey(root: string, key: string): string {
  return path.isAbsolute(key) ? path.resolve(key) : path.resolve(root, ...key.split("/"));
}

/**
 * Rebuild ownership after the manifest was lost or corrupted: a skill
 * directory is ours if its SKILL.md carries the generated marker, and a block
 * is ours because it sits between our markers. Nothing unmarked is claimed.
 */
async function recoverOwnership(
  root: string,
  allowed: ReturnType<typeof allowedRoots>,
): Promise<Previous> {
  const files = new Map<string, OwnedFile & { abs: string }>();
  for (const dir of allowed.skillDirs) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^sillo(-[a-z0-9]+)*$/.test(name)) continue;
      const skillDir = path.join(dir, name);
      const head = (await readText(path.join(skillDir, "SKILL.md"))) ?? "";
      if (!head.includes(GENERATED_MARKER)) continue;
      for (const rel of await listFiles(skillDir)) {
        const abs = path.join(skillDir, ...rel.split("/"));
        const content = (await readText(abs)) ?? "";
        files.set(abs, {
          abs,
          path: manifestKey(root, abs),
          sha256: sha256(content),
          skill: name,
          location: manifestKey(root, dir),
          hosts: [],
        });
      }
    }
  }
  const blocks = new Map<string, OwnedBlock & { abs: string }>();
  for (const file of allowed.instructionFiles) {
    const text = await readText(file);
    const found = text === undefined ? undefined : findBlock(text);
    if (found && found !== "unbalanced") {
      blocks.set(file, {
        abs: file,
        file: manifestKey(root, file),
        sha256: sha256(found.inner),
        hosts: [],
        createdFile: false,
      });
    }
  }
  return { files, blocks, manifest: undefined };
}

async function loadPrevious(
  plan: Plan,
  ctx: HostContext,
  options: ReconcileOptions,
  changes: Change[],
): Promise<{ previous: Previous; quarantined?: { path: string; reason: string } }> {
  const allowed = allowedRoots(plan.scope, ctx);
  const read = await readManifest(plan.root);
  if (read.state === "missing") {
    // No record, but generated files may still be here (a manifest deleted by
    // hand, or a previous install that crashed before writing it).
    return { previous: await recoverOwnership(plan.root, allowed) };
  }
  if (read.state === "corrupt") {
    const where = options.dryRun
      ? path.join(plan.root, MANIFEST_DIR, "manifest.json")
      : await quarantineManifest(plan.root, read.raw);
    return {
      previous: await recoverOwnership(plan.root, allowed),
      quarantined: { path: where, reason: read.reason },
    };
  }
  const manifest = read.manifest;
  if (manifest.scope !== plan.scope) {
    throw new AgentError(
      `The manifest at ${plan.root} records a ${manifest.scope} install, not ${plan.scope}.`,
    );
  }
  const files = new Map<string, OwnedFile & { abs: string }>();
  for (const entry of manifest.files) {
    const abs = resolveKey(plan.root, entry.path);
    if (path.isAbsolute(entry.path) && plan.scope !== "global") {
      changes.push({
        kind: "file",
        path: abs,
        action: "refused",
        hosts: entry.hosts,
        note: "absolute path in a project manifest",
      });
      continue;
    }
    if (!owningSkillDir(abs, allowed)) {
      changes.push({
        kind: "file",
        path: abs,
        action: "refused",
        hosts: entry.hosts,
        note: "outside every Sillo skill location",
      });
      continue;
    }
    files.set(abs, { ...entry, abs });
  }
  const blocks = new Map<string, OwnedBlock & { abs: string }>();
  for (const entry of manifest.blocks) {
    const abs = resolveKey(plan.root, entry.file);
    if (!allowed.instructionFiles.includes(abs)) {
      changes.push({
        kind: "block",
        path: abs,
        action: "refused",
        hosts: entry.hosts,
        note: "not a known instructions file",
      });
      continue;
    }
    blocks.set(abs, { ...entry, abs });
  }
  return { previous: { files, blocks, manifest } };
}

async function backup(root: string, abs: string, content: string, stamp: string): Promise<string> {
  const rel = isWithin(root, abs)
    ? path.relative(root, abs)
    : abs.replace(/^[a-zA-Z]:/, "").replace(/^[/\\]+/, "");
  const target = path.join(root, MANIFEST_DIR, "backups", stamp, rel);
  await writeFileAtomic(root, target, content);
  return target;
}

export async function reconcile(
  plan: Plan,
  ctx: HostContext,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const changes: Change[] = [];
  const backups: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { previous, quarantined } = await loadPrevious(plan, ctx, options, changes);
  const write = async (root: string, abs: string, content: string) => {
    if (!options.dryRun) await writeFileAtomic(root, abs, content);
  };
  const keep = async (root: string, abs: string, content: string) => {
    if (!options.dryRun) backups.push(await backup(root, abs, content, stamp));
  };

  const ownedFiles: OwnedFile[] = [];
  const desiredAbs = new Set(plan.files.map((f) => path.resolve(f.abs)));

  // A skill directory we did not create and do not own is the user's; never
  // write into it, not even a reference file, unless forced.
  const foreignSkills = new Set<string>();
  for (const file of plan.files) {
    if (!file.abs.endsWith(`${path.sep}SKILL.md`)) continue;
    const abs = path.resolve(file.abs);
    if (previous.files.has(abs)) continue;
    const disk = await readText(abs);
    if (disk !== undefined && !disk.includes(GENERATED_MARKER) && disk !== file.content) {
      foreignSkills.add(path.dirname(abs));
    }
  }

  for (const file of plan.files) {
    const abs = path.resolve(file.abs);
    const owned = previous.files.get(abs);
    const disk = await readText(abs);
    const base = { kind: "file" as const, path: abs, skill: file.skill, hosts: file.hosts };
    const record = (sha: string) =>
      ownedFiles.push({
        path: file.key,
        sha256: sha,
        skill: file.skill,
        location: manifestKey(plan.root, file.locationDir),
        hosts: file.hosts,
      });

    if (foreignSkills.has(path.dirname(abs)) || [...foreignSkills].some((d) => isWithin(d, abs))) {
      if (options.force) {
        if (disk !== undefined) await keep(plan.root, abs, disk);
        await write(file.locationDir, abs, file.content);
        changes.push({
          ...base,
          action: "overwritten",
          note: "a skill of the same name was not ours",
        });
        record(file.sha256);
      } else {
        changes.push({
          ...base,
          action: "conflict",
          note: "a skill of this name already exists and is not managed by sillo-agent",
        });
      }
      continue;
    }

    if (disk === undefined) {
      await write(file.locationDir, abs, file.content);
      changes.push({ ...base, action: owned ? "restored" : "created" });
      record(file.sha256);
      continue;
    }
    const diskSha = sha256(disk);
    if (diskSha === file.sha256) {
      changes.push({ ...base, action: owned ? "unchanged" : "adopted" });
      record(file.sha256);
      continue;
    }
    if (!owned) {
      // Present, different, and not in our records.
      if (options.force) {
        await keep(plan.root, abs, disk);
        await write(file.locationDir, abs, file.content);
        changes.push({ ...base, action: "overwritten" });
        record(file.sha256);
      } else {
        changes.push({
          ...base,
          action: "conflict",
          note: "exists and is not managed by sillo-agent",
        });
      }
      continue;
    }
    if (diskSha === owned.sha256) {
      await write(file.locationDir, abs, file.content);
      changes.push({ ...base, action: "updated" });
      record(file.sha256);
      continue;
    }
    // Ours, but edited since we wrote it.
    if (options.force) {
      await keep(plan.root, abs, disk);
      await write(file.locationDir, abs, file.content);
      changes.push({ ...base, action: "overwritten", note: "local edits backed up" });
      record(file.sha256);
    } else {
      changes.push({
        ...base,
        action: "kept-modified",
        note: "edited locally; run with --force to replace (a backup is kept)",
      });
      record(owned.sha256);
    }
  }

  const allowed = allowedRoots(plan.scope, ctx);
  for (const [abs, owned] of previous.files) {
    if (desiredAbs.has(abs)) continue;
    const disk = await readText(abs);
    const base = { kind: "file" as const, path: abs, skill: owned.skill, hosts: owned.hosts };
    if (disk === undefined) continue;
    const root = owningSkillDir(abs, allowed) ?? path.dirname(abs);
    if (sha256(disk) === owned.sha256 || options.force) {
      if (sha256(disk) !== owned.sha256) await keep(plan.root, abs, disk);
      if (!options.dryRun) {
        await removeOwnedFile(root, abs);
        await pruneEmptyDirs(path.dirname(abs), root);
      }
      changes.push({ ...base, action: "removed" });
    } else {
      changes.push({
        ...base,
        action: "left-modified",
        note: "edited locally, so it was left in place",
      });
    }
  }

  // Instruction blocks.
  const ownedBlocks: OwnedBlock[] = [];
  const desiredBlocks = new Set(plan.blocks.map((b) => path.resolve(b.abs)));
  const agentsMdBlock = plan.blocks.find(
    (b) => path.basename(b.abs) === "AGENTS.md" && plan.scope === "project",
  );
  for (const block of plan.blocks) {
    const abs = path.resolve(block.abs);
    const owned = previous.blocks.get(abs);
    const base = { kind: "block" as const, path: abs, hosts: block.hosts };
    const text = await readText(abs);

    // CLAUDE.md that already imports AGENTS.md gets the block through it.
    if (path.basename(abs) === "CLAUDE.md" && agentsMdBlock && importsAgentsMd(text) && !owned) {
      changes.push({
        ...base,
        action: "skipped",
        note: "CLAUDE.md imports AGENTS.md, which carries the block",
      });
      continue;
    }
    const found = text === undefined ? undefined : findBlock(text);
    if (found === "unbalanced") {
      changes.push({
        ...base,
        action: "conflict",
        note: "unbalanced sillo-agent markers; fix them by hand",
      });
      if (owned)
        ownedBlocks.push({
          file: block.key,
          sha256: owned.sha256,
          hosts: block.hosts,
          createdFile: owned.createdFile,
        });
      continue;
    }
    const createdFile = owned?.createdFile ?? text === undefined;
    const recordBlock = (sha: string) =>
      ownedBlocks.push({ file: block.key, sha256: sha, hosts: block.hosts, createdFile });
    if (found && sha256(found.inner) === block.sha256) {
      changes.push({ ...base, action: owned ? "unchanged" : "adopted" });
      recordBlock(block.sha256);
      continue;
    }
    if (found && owned && sha256(found.inner) !== owned.sha256 && !options.force) {
      changes.push({
        ...base,
        action: "kept-modified",
        note: "the Sillo block was edited; run with --force to replace it",
      });
      recordBlock(owned.sha256);
      continue;
    }
    if (found && owned && sha256(found.inner) !== owned.sha256 && text !== undefined)
      await keep(plan.root, abs, text);
    await write(path.dirname(abs), abs, upsertBlock(text, block.content));
    changes.push({
      ...base,
      action: text === undefined ? "created" : found ? "updated" : "created",
    });
    recordBlock(block.sha256);
  }
  for (const [abs, owned] of previous.blocks) {
    if (desiredBlocks.has(abs)) continue;
    const text = await readText(abs);
    const found = text === undefined ? undefined : findBlock(text);
    const base = { kind: "block" as const, path: abs, hosts: owned.hosts };
    if (!found || found === "unbalanced" || text === undefined) continue;
    if (sha256(found.inner) !== owned.sha256 && !options.force) {
      changes.push({
        ...base,
        action: "left-modified",
        note: "the Sillo block was edited, so it was left in place",
      });
      continue;
    }
    const remaining = removeBlock(text);
    if (!options.dryRun) {
      if (owned.createdFile && !remaining.trim()) await removeOwnedFile(path.dirname(abs), abs);
      else await writeFileAtomic(path.dirname(abs), abs, remaining);
    }
    changes.push({ ...base, action: "removed" });
  }

  // The new manifest.
  let manifest: Manifest | undefined;
  if (ownedFiles.length || ownedBlocks.length) {
    const prev = previous.manifest ?? emptyManifest(plan.scope);
    manifest = {
      ...prev,
      version: AGENT_VERSION,
      scope: plan.scope,
      hosts: plan.hosts,
      updatedAt: new Date().toISOString(),
      files: ownedFiles,
      blocks: ownedBlocks,
      options: { ...prev.options, instructions: plan.blocks.length > 0 },
    };
    if (!options.dryRun) await writeManifest(plan.root, manifest);
  } else if (
    !options.dryRun &&
    (previous.manifest || (await exists(path.join(plan.root, MANIFEST_DIR, "manifest.json"))))
  ) {
    await removeManifest(plan.root);
  }

  const result: ReconcileResult = { changes, manifest, backups };
  if (quarantined) result.quarantined = quarantined;
  return result;
}
