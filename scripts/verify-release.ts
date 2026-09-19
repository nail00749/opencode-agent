import { readFileSync } from "node:fs"
import { join } from "node:path"

export function verifyReleaseTag(tag: string, version: string): void {
  if (version.includes("-")) {
    throw new Error(`Stable GitHub releases cannot publish prerelease package version ${version}`)
  }
  const expected = `v${version}`
  if (tag !== expected) {
    throw new Error(`GitHub release tag ${tag || "<missing>"} must equal package version tag ${expected}`)
  }
}

if (import.meta.main) {
  const projectRoot = join(import.meta.dir, "..")
  const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
    version?: unknown
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("package.json must contain a non-empty version")
  }
  verifyReleaseTag(process.env.GVOZD_RELEASE_TAG ?? "", manifest.version)
  console.log(`Verified release tag v${manifest.version}`)
}
