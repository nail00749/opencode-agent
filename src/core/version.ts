/**
 * OpenCode version parsing and range matching shared by the CLI (which reads
 * `opencode --version`) and the runtime plugin (which reads `ctx.app.version`).
 * Kept in `core/` because both the plugin and the CLI need it.
 *
 * Capability note (why the runtime adapts instead of asserting one exact
 * version): within the supported `2.0.*` range the plugin API itself changed.
 * 2.0.2–2.0.3 expose `ctx.catalog.model`, while 2.0.4 split that into the
 * top-level `ctx.model` / `ctx.provider` domains and renamed the refresh event
 * from `catalog.updated` to `model.updated` / `provider.updated`. The plugin
 * therefore detects the surface it was handed rather than keying off a version
 * number; these helpers cover the version *gate* the CLI and diagnostics use.
 */

/** Extracts the first complete semver token from `--version` / host output. */
export function parseOpenCodeVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|\s)/)?.[1]
}

/**
 * Checks a parsed semver against a supported range of the form "2.0.*"
 * (any patch within the major.minor) or an exact "2.0.2". Prerelease tags
 * never satisfy a range that omits one.
 */
export function satisfiesOpenCodeRange(version: string | undefined, range: string): boolean {
  if (!version) return false
  const [prerelease] = version.split("-").slice(1)
  if (prerelease) return false
  if (!range.includes("*")) return version === range
  const [rangeMajor, rangeMinor] = range.split(".").slice(0, 2)
  const [major, minor] = version.split(".").slice(0, 2)
  return major === rangeMajor && minor === rangeMinor
}

/**
 * Compares two semver strings numerically (prerelease is ignored, so "2.0.4"
 * outranks "2.0.4-beta.1"). Returns a negative/zero/positive number like a
 * comparator. Used to prefer the newest compatible OpenCode binary.
 */
export function compareOpenCodeVersions(left: string, right: string): number {
  const parts = (version: string) => version.split("-")[0]!.split(".").map((value) => Number.parseInt(value, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
