/**
 * Minimal SemVer range matching for capability resolution.
 *
 * Supports the subset used by `CapabilityRef.versionRange`:
 *   - exact:        `1.2.3`
 *   - caret:        `^1.2.3`  (same major, >= specified)
 *   - tilde:        `~1.2.3`  (same major+minor, >= specified)
 *   - wildcard:     `*` / `x` (any)
 *
 * This is intentionally small — the adapter only needs to decide whether a
 * registered provider version satisfies a consumer's declared range.
 */

interface Version {
  major: number;
  minor: number;
  patch: number;
}

const WILDCARD: Version = { major: 0, minor: 0, patch: 0 };

function parseVersion(input: string): Version {
  const clean = input.replace(/^[\^~]/, "").trim();
  if (clean === "*" || clean === "x" || clean === "X" || clean === "") {
    return WILDCARD;
  }
  const parts = clean.split(".");
  const major = Number.parseInt(parts[0] ?? "0", 10) || 0;
  const minor = Number.parseInt(parts[1] ?? "0", 10) || 0;
  const patch = Number.parseInt(parts[2] ?? "0", 10) || 0;
  return { major, minor, patch };
}

function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Returns true when `version` satisfies `range`.
 * Pre-release tags are ignored (stripped before parsing).
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version.split("-")[0]!);
  const raw = range.trim();

  if (raw === "*" || raw === "x" || raw === "X" || raw === "") return true;

  const op = raw[0];
  const target = parseVersion(raw);

  if (op === "^") {
    // caret: same major (or same major+minor when major=0), >= target
    if (compare(v, target) < 0) return false;
    if (target.major > 0) return v.major === target.major;
    if (target.minor > 0) return v.major === 0 && v.minor === target.minor;
    return v.major === 0 && v.minor === 0 && v.patch === target.patch;
  }

  if (op === "~") {
    // tilde: same major+minor, >= target
    return compare(v, target) >= 0 && v.major === target.major && v.minor === target.minor;
  }

  // exact
  return compare(v, target) === 0;
}
