/**
 * Just enough PEP 440 to compare Sillo versions and check them against the
 * ranges skills declare. Sillo publishes versions like `1.0.0`, `1.0.0rc1`,
 * `1.0.0a2` and `0.3.2.dev1`, and `1.0.0a1 < 1.0.0rc1 < 1.0.0` must hold, which
 * rules out plain semver comparison.
 */

export interface Version {
  release: number[];
  /** Pre-release: [phase rank, number]; a=0, b=1, rc=2. */
  pre?: [number, number];
  post?: number;
  dev?: number;
  raw: string;
}

const VERSION =
  /^v?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:(?:-(\d+))|(?:[-_.]?(?:post|rev|r)[-_.]?(\d*)))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;

const PRE_RANK: Record<string, number> = {
  a: 0,
  alpha: 0,
  b: 1,
  beta: 1,
  c: 2,
  rc: 2,
  pre: 2,
  preview: 2,
};

export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text.trim());
  if (!m) return undefined;
  const version: Version = { release: m[1]!.split(".").map(Number), raw: text.trim() };
  if (m[2]) version.pre = [PRE_RANK[m[2].toLowerCase()]!, Number(m[3] || 0)];
  if (m[4] !== undefined) version.post = Number(m[4]);
  else if (m[5] !== undefined) version.post = Number(m[5] || 0);
  if (m[6] !== undefined) version.dev = Number(m[6] || 0);
  return version;
}

function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: Version, b: Version): number {
  const len = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < len; i++) {
    const c = cmpNum(a.release[i] ?? 0, b.release[i] ?? 0);
    if (c !== 0) return c;
  }
  // A dev release with no pre-release sorts before any pre-release of that
  // version: 1.0.0.dev1 < 1.0.0a1 < 1.0.0rc1 < 1.0.0 < 1.0.0.post1.
  const preKey = (v: Version): [number, number, number] => {
    if (v.pre) return [1, v.pre[0], v.pre[1]];
    if (v.dev !== undefined && v.post === undefined) return [0, 0, 0];
    return [2, 0, 0];
  };
  const pa = preKey(a);
  const pb = preKey(b);
  for (let i = 0; i < 3; i++) {
    const c = cmpNum(pa[i]!, pb[i]!);
    if (c !== 0) return c;
  }
  const c = cmpNum(a.post ?? -1, b.post ?? -1);
  if (c !== 0) return c;
  return cmpNum(a.dev ?? Number.POSITIVE_INFINITY, b.dev ?? Number.POSITIVE_INFINITY);
}

type Op = ">=" | "<=" | ">" | "<" | "==" | "!=" | "~=";

interface Clause {
  op: Op;
  version: Version;
}

const CLAUSE = /^(>=|<=|==|!=|~=|>|<)?\s*(.+)$/;

/**
 * Parse a range such as `>=1.0.0 <2.0.0` or `>=1.0.0,<2` (PEP 440 separates
 * with commas; whitespace is accepted too, since that is how people write it).
 */
export function parseRange(text: string): Clause[] | undefined {
  const parts = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  // Re-join an operator separated from its version by a space: ">= 1.0".
  const joined: string[] = [];
  for (const part of parts) {
    if (/^(>=|<=|==|!=|~=|>|<)$/.test(part)) joined.push(part);
    else if (joined.length && /^(>=|<=|==|!=|~=|>|<)$/.test(joined[joined.length - 1]!)) {
      joined[joined.length - 1] += part;
    } else joined.push(part);
  }
  const clauses: Clause[] = [];
  for (const part of joined) {
    const m = CLAUSE.exec(part);
    if (!m) return undefined;
    const version = parseVersion(m[2]!.replace(/\.\*$/, ""));
    if (!version) return undefined;
    clauses.push({ op: (m[1] as Op | undefined) ?? "==", version });
  }
  return clauses.length ? clauses : undefined;
}

export function satisfies(version: Version | string, range: string): boolean {
  const v = typeof version === "string" ? parseVersion(version) : version;
  const clauses = parseRange(range);
  if (!v || !clauses) return false;
  return clauses.every(({ op, version: bound }) => {
    const c = compareVersions(v, bound);
    switch (op) {
      case ">=":
        return c >= 0;
      case "<=":
        return c <= 0;
      case ">":
        return c > 0;
      case "<":
        // PEP 440: `<2.0.0` excludes 2.0.0's pre-releases unless the bound is one.
        if (!bound.pre && v.pre && sameRelease(v, bound)) return false;
        return c < 0;
      case "==":
        return c === 0;
      case "!=":
        return c !== 0;
      case "~=": {
        if (c < 0) return false;
        const prefix = bound.release.slice(0, Math.max(1, bound.release.length - 1));
        return prefix.every((n, i) => (v.release[i] ?? 0) === n);
      }
      default:
        return false;
    }
  });
}

function sameRelease(a: Version, b: Version): boolean {
  const len = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < len; i++) if ((a.release[i] ?? 0) !== (b.release[i] ?? 0)) return false;
  return true;
}

export function isValidRange(range: string): boolean {
  return parseRange(range) !== undefined;
}
