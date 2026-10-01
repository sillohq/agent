import os from "node:os";
import path from "node:path";

/**
 * Where things live on this machine, resolved once from the environment.
 *
 * Everything that touches a home directory goes through here so that tests can
 * point the whole tool at a throwaway directory by setting `HOME` (and the
 * host-specific variables below) and nothing else.
 */
export interface Environment {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export function currentEnvironment(overrides: Partial<Environment> = {}): Environment {
  const env = overrides.env ?? process.env;
  return {
    // os.homedir() ignores a changed HOME on some platforms; honour it first so
    // a sandboxed run cannot escape into the real home directory.
    home: overrides.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir(),
    cwd: overrides.cwd ?? process.cwd(),
    platform: overrides.platform ?? process.platform,
    env,
  };
}

/** Expand a leading `~` the way a shell would, for paths read from config. */
export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/** True when `child` is `parent` or somewhere beneath it, after resolution. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A path relative to `root`, with forward slashes, for manifests and output. */
export function toPortable(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join("/");
}

/** The inverse of {@link toPortable}; refuses anything that would leave `root`. */
export function fromPortable(root: string, portable: string): string {
  if (portable.includes("\0")) throw new Error(`Refusing path with a NUL byte: ${portable}`);
  const resolved = path.resolve(root, ...portable.split("/"));
  if (!isWithin(root, resolved)) {
    throw new Error(`Refusing path outside ${root}: ${portable}`);
  }
  return resolved;
}

/** `~/…` for display when a path is under the home directory. */
export function displayPath(p: string, envr: Environment): string {
  if (isWithin(envr.cwd, p) && envr.cwd !== envr.home) {
    const rel = path.relative(envr.cwd, p);
    return rel === "" ? "." : rel.startsWith(".") ? rel : `./${rel}`;
  }
  if (isWithin(envr.home, p)) return `~${path.sep}${path.relative(envr.home, p)}`;
  return p;
}
