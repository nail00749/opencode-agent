import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { renderAgent } from "../agent-generation"
import type { AgentConfig } from "../config"
import { GENERATED_MARKER } from "../constants"

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
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function createFile(path: string, content: string): void {
  const descriptor = openSync(path, "wx", 0o600)
  try {
    writeFileSync(descriptor, content)
  } finally {
    closeSync(descriptor)
  }
}

function replaceFile(path: string, content: string): void {
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
  const agentsDirectory = join(input.configRoot, "agents")
  const result: GlobalSyncResult = { created: [], updated: [], unchanged: [], conflicts: [] }
  const writes: Array<{ path: string; content: string; replace: boolean }> = []

  const rootStat = stat(input.configRoot)
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    throw new Error(`OpenCode config root is not a safe directory: ${input.configRoot}`)
  }
  const directoryStat = stat(agentsDirectory)
  if (directoryStat && (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())) {
    throw new Error(`OpenCode agents path is not a safe directory: ${agentsDirectory}`)
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
    if (!current.includes(GENERATED_MARKER)) {
      result.conflicts.push(path)
      continue
    }
    if (current === content) {
      result.unchanged.push(path)
      continue
    }
    result.updated.push(path)
    writes.push({ path, content, replace: true })
  }

  if (result.conflicts.length > 0) {
    throw new Error(`Refusing to overwrite unmanaged global agents: ${result.conflicts.join(", ")}`)
  }
  if (input.check) return result

  mkdirSync(input.configRoot, { recursive: true, mode: 0o700 })
  mkdirSync(agentsDirectory, { recursive: true, mode: 0o700 })
  for (const write of writes) {
    if (write.replace) replaceFile(write.path, write.content)
    else createFile(write.path, write.content)
  }
  return result
}
