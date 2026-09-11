import { accessSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { renderAgent } from "../agent-generation"
import type { AgentConfig } from "../config"
import { hasGeneratedAgentMarker } from "../constants"
import { secureCanonicalPath } from "../secure-path"

export interface GlobalSyncInput {
  configRoot: string
  agents: Record<string, AgentConfig>
  check?: boolean
}

export interface GlobalSyncResult {
  created: string[]
  updated: string[]
  unchanged: string[]
  conflicts: string[]
  removed: string[]
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function assertWriteable(path: string, label: string): void {
  let candidate = path
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  try {
    const current = lstatSync(candidate)
    if (current.isSymbolicLink() || (!current.isDirectory() && candidate !== path)) throw new Error("unsafe parent")
    const uid = process.getuid?.()
    if (uid !== undefined && (current.uid !== uid || (current.mode & 0o022) !== 0)) throw new Error("unsafe ownership or mode")
    accessSync(candidate, fsConstants.W_OK | (current.isDirectory() ? fsConstants.X_OK : 0))
  } catch {
    throw new Error(`${label} is not writeable: ${path}`)
  }
}

function createFile(path: string, content: string): void {
  const canonicalPath = secureCanonicalPath(path, "Managed global agent path")
  if (canonicalPath !== path) throw new Error(`Managed global agent path changed: ${path}`)
  const descriptor = openSync(canonicalPath, "wx", 0o600)
  try {
    writeFileSync(descriptor, content)
  } finally {
    closeSync(descriptor)
  }
}

function replaceFile(path: string, content: string): void {
  if (secureCanonicalPath(path, "Managed global agent path") !== path) throw new Error(`Managed global agent path changed: ${path}`)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  createFile(temporary, content)
  try {
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}

export function writeManagedAgents(input: GlobalSyncInput): GlobalSyncResult {
  const configRoot = secureCanonicalPath(input.configRoot, "OpenCode config root")
  const agentsDirectory = secureCanonicalPath(join(configRoot, "agents"), "OpenCode agents path")
  const result: GlobalSyncResult = { created: [], updated: [], unchanged: [], conflicts: [], removed: [] }
  const writes: Array<{ path: string; content: string; replace: boolean; previous?: string }> = []
  const removals = new Map<string, string>()
  const enabled = new Set(Object.entries(input.agents).filter(([, agent]) => !agent.disabled).map(([id]) => `${id}.md`))

  const rootStat = stat(configRoot)
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    throw new Error(`OpenCode config root is not a safe directory: ${configRoot}`)
  }
  assertWriteable(configRoot, "OpenCode config root")
  const directoryStat = stat(agentsDirectory)
  if (directoryStat && (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())) {
    throw new Error(`OpenCode agents path is not a safe directory: ${agentsDirectory}`)
  }
  assertWriteable(agentsDirectory, "OpenCode agents directory")
  if (directoryStat) {
    for (const entry of readdirSync(agentsDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || enabled.has(entry.name)) continue
      const path = join(agentsDirectory, entry.name)
      const currentStat = stat(path)
      if (!currentStat || currentStat.isSymbolicLink() || !currentStat.isFile()) continue
      if (hasGeneratedAgentMarker(readFileSync(path, "utf8"))) {
        assertWriteable(path, "Managed global agent")
        result.removed.push(path)
        removals.set(path, readFileSync(path, "utf8"))
      }
    }
  }

  for (const [id, agent] of Object.entries(input.agents).sort(([left], [right]) => left.localeCompare(right))) {
    if (agent.disabled) continue
    const path = join(agentsDirectory, `${id}.md`)
    const content = renderAgent(agent)
    const currentStat = stat(path)
    if (!currentStat) {
      result.created.push(path)
      writes.push({ path, content, replace: false })
      continue
    }
    if (currentStat.isSymbolicLink() || !currentStat.isFile()) {
      result.conflicts.push(path)
      continue
    }
    const current = readFileSync(path, "utf8")
    if (!hasGeneratedAgentMarker(current)) {
      result.conflicts.push(path)
      continue
    }
    assertWriteable(path, "Managed global agent")
    if (current === content) {
      result.unchanged.push(path)
      continue
    }
    result.updated.push(path)
    writes.push({ path, content, replace: true, previous: current })
  }

  if (result.conflicts.length > 0) {
    throw new Error(`Refusing to overwrite unmanaged global agents: ${result.conflicts.join(", ")}`)
  }
  if (input.check) return result

  if (secureCanonicalPath(configRoot, "OpenCode config root") !== configRoot) throw new Error("OpenCode config root changed before write")
  mkdirSync(configRoot, { recursive: true, mode: 0o700 })
  if (secureCanonicalPath(configRoot, "OpenCode config root") !== configRoot) throw new Error("OpenCode config root changed during creation")
  assertWriteable(configRoot, "OpenCode config root")
  if (secureCanonicalPath(agentsDirectory, "OpenCode agents path") !== agentsDirectory) throw new Error("OpenCode agents path changed before creation")
  mkdirSync(agentsDirectory, { recursive: true, mode: 0o700 })
  if (secureCanonicalPath(agentsDirectory, "OpenCode agents path") !== agentsDirectory) throw new Error("OpenCode agents path changed before write")
  assertWriteable(configRoot, "OpenCode config root")
  assertWriteable(agentsDirectory, "OpenCode agents directory")
  for (const path of result.removed) {
    if (secureCanonicalPath(path, "Managed global agent path") !== path) throw new Error(`Managed global agent path changed: ${path}`)
    const currentStat = stat(path)
    if (!currentStat || currentStat.isSymbolicLink() || !currentStat.isFile()) {
      throw new Error(`Refusing to remove a changed or unmanaged global agent: ${path}`)
    }
    const current = readFileSync(path, "utf8")
    if (!hasGeneratedAgentMarker(current) || current !== removals.get(path)) {
      throw new Error(`Refusing to remove a concurrently changed global agent: ${path}`)
    }
    unlinkSync(path)
  }
  for (const write of writes) {
    if (write.replace) {
      const currentStat = stat(write.path)
      const current = currentStat?.isFile() && !currentStat.isSymbolicLink() ? readFileSync(write.path, "utf8") : undefined
      if (!current || !hasGeneratedAgentMarker(current) || current !== write.previous) {
        throw new Error(`Refusing to replace a concurrently changed global agent: ${write.path}`)
      }
      replaceFile(write.path, write.content)
    } else createFile(write.path, write.content)
  }
  return result
}
