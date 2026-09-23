import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PACKAGE_NAME, PACKAGE_VERSION } from "../core/release-metadata"
import { compareOpenCodeVersions } from "../core/version"
import { assertWithin } from "../shared/fs"
import { redactDiagnostic } from "../shared/runtime-events"
import { secureCanonicalPath } from "../shared/secure-path"
import { defaultProcessRunner, findOpenCode, type OpenCodeClient, type ProcessRunner } from "./opencode"

const PACKAGE_ID = "agent-gvozd"
const CACHE_DIRECTORY_PREFIX = `${PACKAGE_ID}@`
const TRACKING_SOURCE = `${PACKAGE_NAME}@latest`

export interface PackageRegistration {
  readonly source: string
  readonly version: string
  readonly cacheTag: string
}

export interface UpdateInput {
  readonly check?: boolean
  readonly findClient?: () => Promise<OpenCodeClient>
  readonly updateCli?: () => Promise<CliUpdateResult>
  readonly resolveLatestVersion?: () => Promise<string>
  /** Override the native-update retry after `plugin add` (tests and slow servers). */
  readonly updateRetry?: { readonly attempts?: number; readonly delayMs?: number }
}

export interface CliUpdateResult {
  readonly beforeVersion: string
  readonly afterVersion: string
  readonly manager?: "bun" | "npm" | "pnpm"
  readonly output?: string
}

export interface UpdateResult {
  readonly status: "checked" | "updated"
  readonly cli: CliUpdateResult
  readonly before: PackageRegistration
  readonly after: PackageRegistration
  readonly checkOutput: string
  readonly updateOutput?: string
  readonly staleCache: readonly string[]
  readonly removedCache: readonly string[]
}

interface GlobalCliUpdateOptions {
  readonly cliEntry?: string
  readonly runner?: ProcessRunner
}

interface GlobalCliUpdateCommand {
  readonly executable: "bun" | "npm" | "pnpm"
  readonly args: readonly string[]
}

/** Keep self-updates in the package-manager root that owns the running CLI. */
export function globalCliUpdateCommand(cliEntry: string, npmGlobalRoot?: string): GlobalCliUpdateCommand {
  const normalized = cliEntry.replaceAll("\\", "/")
  const packageMarker = `/node_modules/${PACKAGE_NAME}/`
  const markerIndex = normalized.indexOf(packageMarker)
  if (markerIndex >= 0 && normalized.includes("/.bun/install/global/node_modules/")) {
    return { executable: "bun", args: ["add", "--global", TRACKING_SOURCE] }
  }
  if (markerIndex >= 0 && (normalized.includes("/pnpm/global/") || normalized.includes("/.local/share/pnpm/global/"))) {
    return { executable: "pnpm", args: ["add", "--global", TRACKING_SOURCE] }
  }
  if (markerIndex >= 0 && npmGlobalRoot) {
    const packageRoot = normalized.slice(0, markerIndex + packageMarker.length - 1)
    const expectedRoot = `${npmGlobalRoot.replaceAll("\\", "/").replace(/\/$/, "")}/${PACKAGE_NAME}`
    if (packageRoot === expectedRoot) {
      return { executable: "npm", args: ["install", "--global", TRACKING_SOURCE] }
    }
  }
  throw new Error(
    `Cannot determine the global package manager for ${cliEntry}; bootstrap with one of: bun add --global ${TRACKING_SOURCE}; npm install --global ${TRACKING_SOURCE}; pnpm add --global ${TRACKING_SOURCE}`,
  )
}

function installedCliVersion(cliEntry: string): string {
  const manifestPath = join(dirname(dirname(cliEntry)), "package.json")
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    throw new Error(`Cannot read the installed Gvozd package: ${redactDiagnostic(error)}`)
  }
  if (!manifest || typeof manifest !== "object" || (manifest as { name?: unknown }).name !== PACKAGE_NAME) {
    throw new Error(`The running CLI is not installed from ${PACKAGE_NAME}`)
  }
  const version = (manifest as { version?: unknown }).version
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("The installed Gvozd package has an invalid version")
  }
  return version
}

export async function updateGlobalCli(options: GlobalCliUpdateOptions = {}): Promise<CliUpdateResult> {
  const cliEntry = options.cliEntry ?? fileURLToPath(import.meta.url)
  const runner = options.runner ?? defaultProcessRunner
  const beforeVersion = installedCliVersion(cliEntry)
  let command: GlobalCliUpdateCommand
  try {
    command = globalCliUpdateCommand(cliEntry)
  } catch {
    const root = await runner.run("npm", ["root", "--global"], 30_000)
    if (root.code !== 0) {
      throw new Error(`Cannot determine the global package manager; bootstrap with one of: bun add --global ${TRACKING_SOURCE}; npm install --global ${TRACKING_SOURCE}; pnpm add --global ${TRACKING_SOURCE}`)
    }
    command = globalCliUpdateCommand(cliEntry, root.stdout.trim())
  }
  const result = await runner.run(command.executable, command.args, 120_000)
  if (result.code !== 0) {
    const detail = redactDiagnostic(result.stderr.trim())
    throw new Error(`Global Gvozd update exited ${result.code}${detail ? `: ${detail}` : ""}`)
  }
  const afterVersion = installedCliVersion(cliEntry)
  if (compareOpenCodeVersions(afterVersion, beforeVersion) < 0) {
    throw new Error(`Global Gvozd update unexpectedly downgraded ${beforeVersion} to ${afterVersion}`)
  }
  return {
    beforeVersion,
    afterVersion,
    manager: command.executable,
    output: result.stdout.trim(),
  }
}

/** Query npm outside OpenCode so a stalled host-side update check cannot hold the plugin mutex. */
export async function latestPackageVersion(runner: ProcessRunner = defaultProcessRunner): Promise<string> {
  const result = await runner.run("npm", ["view", TRACKING_SOURCE, "version", "--json", "--prefer-online"], 30_000)
  if (result.code !== 0) {
    const detail = redactDiagnostic(result.stderr.trim())
    throw new Error(`npm version check exited ${result.code}${detail ? `: ${detail}` : ""}`)
  }
  const raw = result.stdout.trim()
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {}
  const version = typeof parsed === "string" ? parsed : undefined
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("npm returned an invalid Gvozd version")
  }
  return version
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

/**
 * Retry the native server-side plugin update after a fresh `plugin add`.
 * Evidence (2026-09-23, OpenCode v2.0.15): POST /api/plugin/update for a just
 * added target fails fast with HTTP 400, while the identical request succeeds
 * ~20s later. The server needs settle time after the registration rewrite, so
 * retry a bounded number of times before the caller rolls back. Delays and
 * attempts are injectable for tests; production defaults add at most ~10s.
 */
export async function pluginUpdateWithRetry(
  client: OpenCodeClient,
  source: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<string> {
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 10_000
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return (await client.pluginUpdate(source)).trim()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

async function awaitRegistration(
  client: OpenCodeClient,
  expectedSource: string,
  expectedVersion: string,
  timeoutMs = 15_000,
): Promise<PackageRegistration> {
  const started = Date.now()
  let lastError: unknown
  for (;;) {
    try {
      const registration = parsePackageRegistration(await client.pluginList())
      if (registration.source === expectedSource && registration.version === expectedVersion) return registration
      lastError = new Error(`OpenCode still reports ${registration.source} at ${registration.version}`)
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
  const tracksLatest = before.cacheTag === "latest"
  const staleBefore = stalePackageCache(paths.cache, before)
  if (input.check) {
    const latest = await (input.resolveLatestVersion ?? latestPackageVersion)()
    const versionStatus = compareOpenCodeVersions(latest, before.version) > 0
      ? `update available ${before.version} -> ${latest}`
      : compareOpenCodeVersions(latest, before.version) < 0
        ? `installed ${before.version} is newer than npm latest ${latest}`
        : `npm latest ${latest} is installed`
    const checkOutput = tracksLatest
      ? versionStatus
      : `Pinned registration ${before.source}; update will migrate it to ${TRACKING_SOURCE}; ${versionStatus}`
    return {
      status: "checked",
      cli: { beforeVersion: PACKAGE_VERSION, afterVersion: PACKAGE_VERSION },
      before,
      after: before,
      checkOutput,
      staleCache: staleBefore,
      removedCache: [],
    }
  }

  const checkOutput = ""
  const cli = await (input.updateCli ?? updateGlobalCli)()
  let updateOutput: string
  if (tracksLatest) {
    updateOutput = (await client.pluginUpdate(before.source)).trim()
  } else {
    await client.pluginRemove(before.source)
    let trackingAdded = false
    try {
      await client.pluginAdd(TRACKING_SOURCE)
      trackingAdded = true
      const nativeOutput = await pluginUpdateWithRetry(client, TRACKING_SOURCE, input.updateRetry)
      updateOutput = [`Migrated ${before.source} to ${TRACKING_SOURCE}`, nativeOutput].filter(Boolean).join("\n")
    } catch (error) {
      const cause = redactDiagnostic(error)
      if (trackingAdded) {
        try {
          await client.pluginRemove(TRACKING_SOURCE)
        } catch {
          throw new Error(
            `Failed to migrate ${before.source} to ${TRACKING_SOURCE} (${cause}); the new registration could not be removed. Run gvozd setup --yes to reconcile registrations.`,
          )
        }
      }
      try {
        await client.pluginAdd(before.source)
      } catch {
        throw new Error(`Failed to migrate ${before.source} to ${TRACKING_SOURCE} (${cause}); restoring the previous registration also failed`)
      }
      try {
        const restored = parsePackageRegistration(await client.pluginList())
        if (restored.source !== before.source || restored.version !== before.version) throw new Error("restored registration mismatch")
      } catch {
        throw new Error(`Failed to migrate ${before.source} to ${TRACKING_SOURCE} (${cause}); the previous registration could not be verified. Run gvozd setup --yes.`)
      }
      throw new Error(`Failed to migrate ${before.source} to ${TRACKING_SOURCE} (${cause}); the previous registration was restored`)
    }
  }
  await client.serviceRestart()
  const after = await awaitRegistration(client, tracksLatest ? before.source : TRACKING_SOURCE, cli.afterVersion)
  if (after.version !== cli.afterVersion) {
    throw new Error(`Gvozd update is incomplete: CLI is ${cli.afterVersion}, but OpenCode loaded plugin ${after.version}`)
  }
  const staleAfter = stalePackageCache(paths.cache, after)
  const removedCache = removeStalePackageCache(paths.cache, staleAfter)
  return {
    status: "updated",
    cli,
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
    ? [
        `Gvozd CLI ${result.cli.beforeVersion}: installed`,
        `OpenCode plugin ${result.before.version}: ${result.checkOutput || "update check complete"}`,
      ]
    : [
        `Gvozd CLI ${result.cli.beforeVersion} -> ${result.cli.afterVersion}: update complete`,
        `OpenCode plugin ${result.before.version} -> ${result.after.version}: update complete`,
      ]
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
