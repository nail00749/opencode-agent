import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { basename, dirname, join, relative } from "node:path"
import type { ResolvedConfig } from "./config"
import {
  GENERATED_PLUGIN_MARKER,
  hasGeneratedAgentMarker,
  hasGeneratedPluginMarker,
  hasGeneratedSchemaMarker,
  isEquivalentLegacySchema,
} from "./constants"
import { renderAgent } from "./agent-generation"
import { withExclusiveFileLockSync } from "./file-lock"

export interface SyncResult {
  created: string[]
  updated: string[]
  removed: string[]
  unchanged: string[]
}

export interface SyncOptions {
  check?: boolean
  onDiff?: (diff: string) => void
  /**
   * Also write the project-local plugin entrypoint. Dev mode only: the local
   * entrypoint re-exports the checked-out source and collides with the
   * globally registered npm plugin ("Duplicate plugin ID: agent-gvozd") when
   * OpenCode loads a project that has both. Consumer projects never need it;
   * the global plugin serves them.
   */
  devPlugin?: boolean
}

function renderPluginEntrypoint(config: ResolvedConfig, destination: string): string {
  let moduleSpecifier = "agent-gvozd/server"
  if (realpathSync(config.packageRoot) === realpathSync(config.projectRoot)) {
    moduleSpecifier = relative(destination, join(config.packageRoot, "src", "index")).replaceAll("\\", "/")
    if (!moduleSpecifier.startsWith(".")) moduleSpecifier = `./${moduleSpecifier}`
  }
  return [GENERATED_PLUGIN_MARKER, `export { default } from ${JSON.stringify(moduleSpecifier)}`, ""].join("\n")
}

function renderDiff(path: string, before: string, after: string): string {
  const previous = before === "" ? [] : before.split("\n")
  const next = after === "" ? [] : after.split("\n")
  let prefix = 0
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++
  }
  const contextStart = Math.max(0, prefix - 3)
  const previousEnd = Math.min(previous.length, previous.length - suffix + 3)
  const nextEnd = Math.min(next.length, next.length - suffix + 3)
  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${contextStart + 1},${previousEnd - contextStart} +${contextStart + 1},${nextEnd - contextStart} @@`,
    ...previous.slice(contextStart, prefix).map((line) => ` ${line}`),
    ...previous.slice(prefix, previous.length - suffix).map((line) => `-${line}`),
    ...next.slice(prefix, next.length - suffix).map((line) => `+${line}`),
    ...next.slice(next.length - suffix, nextEnd).map((line) => ` ${line}`),
  ].join("\n")
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function safeDirectory(root: string, segments: string[], create: boolean): string {
  let current = realpathSync(root)
  for (const segment of segments) {
    current = join(current, segment)
    const currentStat = stat(current)
    if (currentStat) {
      if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
        throw new Error(`Refusing unsafe output directory: ${current}`)
      }
      continue
    }
    if (create) mkdirSync(current)
  }
  return current
}

function assertRegularFile(path: string): boolean {
  const current = stat(path)
  if (!current) return false
  if (current.isSymbolicLink() || !current.isFile()) throw new Error(`Refusing unsafe output file: ${path}`)
  return true
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

interface TemplateWrite {
  target: string
  content: string
  replace: boolean
  previous?: string
}

function planProjectTemplate(config: ResolvedConfig, result: SyncResult, check: boolean): TemplateWrite[] {
  const directory = safeDirectory(config.projectRoot, ["docs", ".gvozd"], !check)
  const writes: TemplateWrite[] = []
  const configPath = join(directory, "config.jsonc")
  if (!assertRegularFile(configPath)) {
    result.created.push(configPath)
    writes.push({
      target: configPath,
      replace: false,
      content: [
        "{",
        '  "$schema": "./schema.json",',
        "  // Project overrides are merged after built-in and global configuration.",
        '  "agents": {}',
        "}",
        "",
      ].join("\n"),
    })
  }
  const schemaSource = join(dirname(config.sources[0]!), "schema.json")
  const schemaTarget = join(directory, "schema.json")
  const schema = readFileSync(schemaSource, "utf8")
  if (!assertRegularFile(schemaTarget)) {
    result.created.push(schemaTarget)
    writes.push({ target: schemaTarget, content: schema, replace: false })
  } else {
    const current = readFileSync(schemaTarget, "utf8")
    if (current !== schema) {
      if (!hasGeneratedSchemaMarker(current) && !isEquivalentLegacySchema(current, schema)) {
        throw new Error(`Refusing to overwrite an unmanaged project schema: ${schemaTarget}`)
      }
      result.updated.push(schemaTarget)
      writes.push({ target: schemaTarget, content: schema, replace: true, previous: current })
    }
  }
  return writes
}

function syncAgentsUnlocked(config: ResolvedConfig, options: SyncOptions): SyncResult {
  const check = options.check ?? false
  const destination = safeDirectory(config.projectRoot, [".opencode", "agents"], false)
  const pluginDestination = safeDirectory(config.projectRoot, [".opencode", "plugins", "agent-gvozd"], false)
  const result: SyncResult = { created: [], updated: [], removed: [], unchanged: [] }
  const writes: Array<{ target: string; content: string; replace: boolean; previous?: string }> = []
  let pluginWrite: { target: string; content: string; replace: boolean; previous?: string } | undefined
  const removals = new Map<string, string>()

  const templateWrites = planProjectTemplate(config, result, check)
  const enabled = new Set(Object.entries(config.agents).filter(([, agent]) => !agent.disabled).map(([id]) => `${id}.md`))
  if (stat(destination)) {
    for (const entry of readdirSync(destination, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || enabled.has(entry.name)) continue
      const target = join(destination, entry.name)
      const current = readFileSync(target, "utf8")
      if (!hasGeneratedAgentMarker(current)) continue
      result.removed.push(target)
      removals.set(target, current)
      options.onDiff?.(renderDiff(target, current, ""))
    }
  }

  for (const [id, agent] of Object.entries(config.agents)) {
    if (agent.disabled) continue
    const target = join(destination, `${id}.md`)
    const content = renderAgent(agent)
    if (!assertRegularFile(target)) {
      result.created.push(target)
      writes.push({ target, content, replace: false })
      continue
    }

    const current = readFileSync(target, "utf8")
    if (current === content) {
      result.unchanged.push(target)
      continue
    }
    if (!hasGeneratedAgentMarker(current)) {
      throw new Error(`Refusing to overwrite a non-generated agent file: ${target}`)
    }
    result.updated.push(target)
    options.onDiff?.(renderDiff(target, current, content))
    writes.push({ target, content, replace: true, previous: current })
  }

  const pluginTarget = join(pluginDestination, "index.ts")
  const pluginContent = renderPluginEntrypoint(config, pluginDestination)
  if (!options.devPlugin) {
    // Dev plugin disabled: remove a previously generated local entrypoint so
    // OpenCode loads only the globally registered npm plugin in this project.
    if (assertRegularFile(pluginTarget)) {
      const current = readFileSync(pluginTarget, "utf8")
      if (hasGeneratedPluginMarker(current)) {
        result.removed.push(pluginTarget)
        removals.set(pluginTarget, current)
        options.onDiff?.(renderDiff(pluginTarget, current, ""))
      }
    }
  } else if (!assertRegularFile(pluginTarget)) {
    result.created.push(pluginTarget)
    pluginWrite = { target: pluginTarget, content: pluginContent, replace: false }
  } else {
    const current = readFileSync(pluginTarget, "utf8")
    if (current === pluginContent) {
      result.unchanged.push(pluginTarget)
    } else {
      if (!hasGeneratedPluginMarker(current)) {
        throw new Error(`Refusing to overwrite a non-generated plugin entrypoint: ${pluginTarget}`)
      }
      result.updated.push(pluginTarget)
      options.onDiff?.(renderDiff(pluginTarget, current, pluginContent))
      pluginWrite = { target: pluginTarget, content: pluginContent, replace: true, previous: current }
    }
  }

  if (!check) {
    const writableDestination = safeDirectory(config.projectRoot, [".opencode", "agents"], true)
    const writablePluginDestination = safeDirectory(config.projectRoot, [".opencode", "plugins", "agent-gvozd"], true)
    for (const target of result.removed) {
      if (!assertRegularFile(target)) {
        throw new Error(`Refusing to remove a changed or unsafe generated file: ${target}`)
      }
      const current = readFileSync(target, "utf8")
      const generated = target.endsWith("index.ts")
        ? hasGeneratedPluginMarker(current)
        : hasGeneratedAgentMarker(current)
      if (!generated || current !== removals.get(target)) {
        throw new Error(`Refusing to remove a concurrently changed generated file: ${target}`)
      }
      unlinkSync(target)
    }
    for (const write of writes) {
      if (!write.replace) {
        createFile(join(writableDestination, basename(write.target)), write.content)
        continue
      }
      if (!assertRegularFile(write.target)) {
        throw new Error(`Refusing to replace a changed or unsafe agent file: ${write.target}`)
      }
      const current = readFileSync(write.target, "utf8")
      if (!hasGeneratedAgentMarker(current) || current !== write.previous) {
        throw new Error(`Refusing to replace a concurrently changed agent file: ${write.target}`)
      }
      replaceFile(write.target, write.content)
    }
    if (pluginWrite) {
      const target = join(writablePluginDestination, basename(pluginWrite.target))
      if (!pluginWrite.replace) {
        createFile(target, pluginWrite.content)
      } else {
        if (!assertRegularFile(target)) {
          throw new Error(`Refusing to replace a changed or unsafe plugin entrypoint: ${target}`)
        }
        const current = readFileSync(target, "utf8")
        if (!hasGeneratedPluginMarker(current) || current !== pluginWrite.previous) {
          throw new Error(`Refusing to replace a concurrently changed plugin entrypoint: ${target}`)
        }
        replaceFile(target, pluginWrite.content)
      }
    }
    const templateDirectory = safeDirectory(config.projectRoot, ["docs", ".gvozd"], true)
    for (const write of templateWrites) {
      const target = join(templateDirectory, basename(write.target))
      if (!write.replace) createFile(target, write.content)
      else {
        if (!assertRegularFile(target) || readFileSync(target, "utf8") !== write.previous) {
          throw new Error(`Refusing to replace a concurrently changed project schema: ${target}`)
        }
        replaceFile(target, write.content)
      }
    }
  }

  if (!check) safeDirectory(config.projectRoot, ["docs", ".gvozd", "tasks"], true)
  return result
}

export function syncAgents(config: ResolvedConfig, options: SyncOptions = {}): SyncResult {
  if (options.check) return syncAgentsUnlocked(config, options)
  const root = realpathSync(config.projectRoot)
  return withExclusiveFileLockSync(join(root, ".agent-gvozd-sync.lock"), () => syncAgentsUnlocked(config, options), "sync")
}

export function formatSyncResult(result: SyncResult, check: boolean): string {
  const lines = [check ? "agent-gvozd sync check" : "agent-gvozd sync complete"]
  for (const [label, paths] of [
    ["create", result.created],
    ["update", result.updated],
    ["remove", result.removed],
    ["unchanged", result.unchanged],
  ] as const) {
    for (const path of paths) lines.push(`${label.padEnd(9)} ${basename(path)}`)
  }
  return lines.join("\n")
}
