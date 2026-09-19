import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import { PACKAGE_NAME } from "../core/release-metadata"
import { compareOpenCodeVersions } from "../core/version"
import { assertWithin } from "../shared/fs"
import { secureCanonicalPath } from "../shared/secure-path"
import { findOpenCode, type OpenCodeClient } from "./opencode"

const PACKAGE_ID = "agent-gvozd"
const CACHE_DIRECTORY_PREFIX = `${PACKAGE_ID}@`

export interface PackageRegistration {
  readonly source: string
  readonly version: string
  readonly cacheTag: string
}

export interface UpdateInput {
  readonly check?: boolean
  readonly findClient?: () => Promise<OpenCodeClient>
}

export interface UpdateResult {
  readonly status: "checked" | "updated"
  readonly before: PackageRegistration
  readonly after: PackageRegistration
  readonly checkOutput: string
  readonly updateOutput?: string
  readonly staleCache: readonly string[]
  readonly removedCache: readonly string[]
}

function packageSourcePattern(): RegExp {
  return new RegExp(`${PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@([^\\s]+)`)
}

/** Resolve the exact configured target instead of assuming this CLI is the active plugin version. */
export function parsePackageRegistration(output: string): PackageRegistration {
  const matches = output
    .split(/\r?\n/)
    .map((line) => {
      const sourceMatch = line.match(packageSourcePattern())
      if (!sourceMatch) return undefined
      const fields = line.trim().split(/\s+/)
      const source = sourceMatch[0]
      const cacheTag = sourceMatch[1]!
      const version = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(cacheTag)
        ? cacheTag.replace(/^v/, "")
        : fields.find((field) => /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(field))?.replace(/^v/, "")
      return version ? { source, version, cacheTag } : undefined
    })
    .filter((entry): entry is PackageRegistration => entry !== undefined)
  const unique = [...new Map(matches.map((entry) => [entry.source, entry])).values()]
  if (unique.length === 0) throw new Error(`${PACKAGE_NAME} is not registered; run gvozd setup once`)
  if (unique.length > 1) throw new Error(`Multiple ${PACKAGE_NAME} targets are registered; run gvozd setup once to reconcile them`)
  return unique[0]!
}

function packageCacheDirectory(cacheRoot: string): string {
  const canonicalRoot = secureCanonicalPath(cacheRoot, "OpenCode cache root")
  const directory = secureCanonicalPath(join(canonicalRoot, "npm", "@nail00749"), "Gvozd package cache")
  assertWithin(canonicalRoot, directory, "Gvozd package cache")
  return directory
}

/** Return old Gvozd version roots only; timestamped installs below the active version stay intact. */
export function stalePackageCache(cacheRoot: string, active: PackageRegistration): string[] {
  const directory = packageCacheDirectory(cacheRoot)
  if (!existsSync(directory)) return []
  const root = lstatSync(directory)
  const uid = process.getuid?.()
  if (root.isSymbolicLink() || !root.isDirectory() || (uid !== undefined && root.uid !== uid)) {
    throw new Error(`Gvozd package cache is not an owner-controlled directory: ${directory}`)
  }
  const retained = new Set([`${CACHE_DIRECTORY_PREFIX}${active.version}`, `${CACHE_DIRECTORY_PREFIX}${active.cacheTag}`])
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.name.startsWith(CACHE_DIRECTORY_PREFIX) || retained.has(entry.name)) return false
      const version = entry.name.slice(CACHE_DIRECTORY_PREFIX.length).replace(/^v/, "")
      if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return false
      // A freshly downloaded version can become visible before plugin list
      // switches over. Never delete an equal or newer cache root.
      return compareOpenCodeVersions(version, active.version) < 0
    })
    .map((entry) => {
      const target = secureCanonicalPath(join(directory, entry.name), "Stale Gvozd cache entry")
      assertWithin(directory, target, "Stale Gvozd cache entry")
      const stat = lstatSync(target)
      if (!entry.isDirectory() || entry.isSymbolicLink() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
        throw new Error(`Refusing to remove unsafe Gvozd cache entry: ${target}`)
      }
      return target
    })
    .sort()
}

function removeStalePackageCache(cacheRoot: string, paths: readonly string[]): string[] {
  const directory = packageCacheDirectory(cacheRoot)
  const uid = process.getuid?.()
  const removed: string[] = []
  for (const path of paths) {
    const target = secureCanonicalPath(path, "Stale Gvozd cache entry")
    assertWithin(directory, target, "Stale Gvozd cache entry")
    const stat = lstatSync(target)
    if (!basename(target).startsWith(CACHE_DIRECTORY_PREFIX) || stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
      throw new Error(`Refusing to remove unsafe Gvozd cache entry: ${target}`)
    }
    rmSync(target, { recursive: true, force: false })
    removed.push(target)
  }
  return removed
}

async function awaitRegistration(client: OpenCodeClient, timeoutMs = 15_000): Promise<PackageRegistration> {
  const started = Date.now()
  let lastError: unknown
  for (;;) {
    try {
      return parsePackageRegistration(await client.pluginList())
    } catch (error) {
      lastError = error
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`OpenCode did not report the updated Gvozd plugin within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

export async function runUpdate(input: UpdateInput = {}): Promise<UpdateResult> {
  const client = await (input.findClient ?? findOpenCode)()
  const paths = await client.debugPaths()
  if (!paths.cache) throw new Error("OpenCode did not report its cache path")
  const before = parsePackageRegistration(await client.pluginList())
  const checkOutput = (await client.pluginCheck(before.source)).trim()
  const staleBefore = stalePackageCache(paths.cache, before)
  if (input.check) {
    return {
      status: "checked",
      before,
      after: before,
      checkOutput,
      staleCache: staleBefore,
      removedCache: [],
    }
  }

  const updateOutput = (await client.pluginUpdate(before.source)).trim()
  await client.serviceRestart()
  const after = await awaitRegistration(client)
  const staleAfter = stalePackageCache(paths.cache, after)
  const removedCache = removeStalePackageCache(paths.cache, staleAfter)
  await client.pluginCheck(after.source)
  return {
    status: "updated",
    before,
    after,
    checkOutput,
    updateOutput,
    staleCache: staleAfter,
    removedCache,
  }
}

export function renderUpdateResult(result: UpdateResult): string {
  const lines = result.status === "checked"
    ? [`Gvozd ${result.before.version}: ${result.checkOutput || "update check complete"}`]
    : [`Gvozd ${result.before.version} -> ${result.after.version}: update complete`]
  if (result.status === "updated" && result.updateOutput) lines.push(result.updateOutput)
  if (result.status === "checked") {
    lines.push(result.staleCache.length === 0
      ? "Cache: no stale Gvozd versions"
      : `Cache: ${result.staleCache.length} stale Gvozd version(s): ${result.staleCache.map((path) => basename(path)).join(", ")}`)
  } else {
    lines.push(result.removedCache.length === 0
      ? "Cache: no stale Gvozd versions"
      : `Cache: removed ${result.removedCache.length} stale Gvozd version(s): ${result.removedCache.map((path) => basename(path)).join(", ")}`)
  }
  return lines.join("\n")
}
