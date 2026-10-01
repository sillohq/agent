import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentError, isNodeError } from "./errors.js";
import { isWithin } from "./paths.js";

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function readText(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Refuse to write through a symlink anywhere between `root` and `target`.
 *
 * Every file this tool writes is inside a directory it was told it may write
 * to. A symlink planted along the way would redirect that write somewhere else
 * entirely, so the whole chain is checked, not just the final component.
 * The root itself may be a symlink: that is the user's own arrangement (a
 * dotfiles repository linking ~/.claude, say) and following it is expected.
 */
export async function assertNoSymlinks(root: string, target: string): Promise<void> {
  if (!isWithin(root, target)) {
    throw new AgentError(`Refusing to touch ${target}: it is outside ${root}.`);
  }
  const rel = path.relative(root, target);
  if (rel === "") return;
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new AgentError(`Refusing to write through a symbolic link: ${current}`, {
        hint: "Sillo Agent only writes real files it owns. Remove the link or install to another scope.",
      });
    }
  }
}

/**
 * Write a file atomically: to a sibling temporary file, then rename over the
 * target. A crash mid-write leaves the old file or the new one, never half of
 * one, which matters for files the user also edits (AGENTS.md, CLAUDE.md).
 */
export async function writeFileAtomic(
  root: string,
  target: string,
  content: string,
): Promise<void> {
  await assertNoSymlinks(root, target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** Remove a file this tool owns. Never a directory, never through a link. */
export async function removeOwnedFile(root: string, target: string): Promise<boolean> {
  await assertNoSymlinks(root, path.dirname(target));
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile()) {
    throw new AgentError(`Refusing to remove ${target}: it is not a regular file.`);
  }
  await fs.rm(target);
  return true;
}

/**
 * Remove `dir` and its parents up to (not including) `stopAt`, for as long as
 * each is empty. Directories holding anything we did not create are left be.
 */
export async function pruneEmptyDirs(dir: string, stopAt: string): Promise<void> {
  let current = dir;
  while (isWithin(stopAt, current) && path.resolve(current) !== path.resolve(stopAt)) {
    try {
      const entries = await fs.readdir(current);
      if (entries.length > 0) return;
      await fs.rmdir(current);
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) return;
      throw error;
    }
    current = path.dirname(current);
  }
}

export async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.X_OK);
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Find an executable on PATH the way a shell would, without running anything. */
export async function which(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").concat("") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (platform === "win32") {
        if (await exists(candidate)) return candidate;
      } else if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Recursively list regular files under `dir`, relative, with `/` separators. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  }
  await walk(dir);
  return out.sort();
}
