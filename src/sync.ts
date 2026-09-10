import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"
import type { AgentConfig, PermissionRule, ResolvedConfig } from "./config"
import { GENERATED_MARKER, GENERATED_PLUGIN_MARKER } from "./constants"

export interface SyncResult {
  created: string[]
  updated: string[]
  removed: string[]
  unchanged: string[]
}

export interface SyncOptions {
  check?: boolean
  onDiff?: (diff: string) => void
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function renderPermissions(rules: PermissionRule[]): string[] {
  if (rules.length === 0) return []
  return [
    "permissions:",
    ...rules.flatMap((rule) => [
      `  - action: ${yamlString(rule.action)}`,
      `    resource: ${yamlString(rule.resource)}`,
      `    effect: ${rule.effect}`,
    ]),
  ]
}

function renderAgent(agent: AgentConfig): string {
  const prompt = readFileSync(agent.prompt, "utf8").trim()
  const permissions: PermissionRule[] = [
    ...agent.permissions,
    { action: "skill", resource: "*", effect: "deny" },
    ...agent.skills.map((skill): PermissionRule => ({ action: "skill", resource: skill, effect: "allow" })),
  ]
  return [
    "---",
    GENERATED_MARKER,
    `description: ${yamlString(agent.description)}`,
    `mode: ${agent.mode}`,
    ...renderPermissions(permissions),
    "---",
    "",
    prompt,
    "",
  ].join("\n")
}

function renderPluginEntrypoint(): string {
  return [GENERATED_PLUGIN_MARKER, 'export { default } from "agent-gvozd/server"', ""].join("\n")
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

function ensureProjectTemplate(config: ResolvedConfig, check: boolean): void {
  const directory = safeDirectory(config.projectRoot, ["docs", ".gvozd"], !check)
  const path = join(directory, "config.jsonc")
  if (check) return
  if (!assertRegularFile(path)) {
    createFile(
      path,
      [
        "{",
        '  "$schema": "./schema.json",',
        "  // Project overrides are merged after built-in and global configuration.",
        '  "agents": {}',
        "}",
        "",
      ].join("\n"),
    )
  }
  const schemaSource = join(dirname(config.sources[0]!), "schema.json")
  const schemaTarget = join(directory, "schema.json")
  const schema = readFileSync(schemaSource, "utf8")
  if (assertRegularFile(schemaTarget)) replaceFile(schemaTarget, schema)
  else createFile(schemaTarget, schema)
}

export function syncAgents(config: ResolvedConfig, options: SyncOptions = {}): SyncResult {
  const check = options.check ?? false
  const destination = safeDirectory(config.projectRoot, [".opencode", "agents"], false)
  const pluginDestination = safeDirectory(config.projectRoot, [".opencode", "plugins", "agent-gvozd"], false)
  const result: SyncResult = { created: [], updated: [], removed: [], unchanged: [] }
  const writes: Array<{ target: string; content: string; replace: boolean }> = []
  let pluginWrite: { target: string; content: string; replace: boolean } | undefined

  const enabled = new Set(Object.entries(config.agents).filter(([, agent]) => !agent.disabled).map(([id]) => `${id}.md`))
  if (stat(destination)) {
    for (const entry of readdirSync(destination, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || enabled.has(entry.name)) continue
      const target = join(destination, entry.name)
      const current = readFileSync(target, "utf8")
      if (!current.includes(GENERATED_MARKER)) continue
      result.removed.push(target)
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
    if (!current.includes(GENERATED_MARKER)) {
      throw new Error(`Refusing to overwrite a non-generated agent file: ${target}`)
    }
    result.updated.push(target)
    options.onDiff?.(renderDiff(target, current, content))
    writes.push({ target, content, replace: true })
  }

  const pluginTarget = join(pluginDestination, "index.ts")
  const pluginContent = renderPluginEntrypoint()
  if (!assertRegularFile(pluginTarget)) {
    result.created.push(pluginTarget)
    pluginWrite = { target: pluginTarget, content: pluginContent, replace: false }
  } else {
    const current = readFileSync(pluginTarget, "utf8")
    if (current === pluginContent) {
      result.unchanged.push(pluginTarget)
    } else {
      if (!current.includes(GENERATED_PLUGIN_MARKER)) {
        throw new Error(`Refusing to overwrite a non-generated plugin entrypoint: ${pluginTarget}`)
      }
      result.updated.push(pluginTarget)
      options.onDiff?.(renderDiff(pluginTarget, current, pluginContent))
      pluginWrite = { target: pluginTarget, content: pluginContent, replace: true }
    }
  }

  if (!check) {
    const writableDestination = safeDirectory(config.projectRoot, [".opencode", "agents"], true)
    const writablePluginDestination = safeDirectory(config.projectRoot, [".opencode", "plugins", "agent-gvozd"], true)
    for (const target of result.removed) {
      if (!assertRegularFile(target) || !readFileSync(target, "utf8").includes(GENERATED_MARKER)) {
        throw new Error(`Refusing to remove a changed or unsafe agent file: ${target}`)
      }
      unlinkSync(target)
    }
    for (const write of writes) {
      if (!write.replace) {
        createFile(join(writableDestination, basename(write.target)), write.content)
        continue
      }
      if (!assertRegularFile(write.target) || !readFileSync(write.target, "utf8").includes(GENERATED_MARKER)) {
        throw new Error(`Refusing to replace a changed or unsafe agent file: ${write.target}`)
      }
      replaceFile(write.target, write.content)
    }
    if (pluginWrite) {
      const target = join(writablePluginDestination, basename(pluginWrite.target))
      if (!pluginWrite.replace) {
        createFile(target, pluginWrite.content)
      } else {
        if (!assertRegularFile(target) || !readFileSync(target, "utf8").includes(GENERATED_PLUGIN_MARKER)) {
          throw new Error(`Refusing to replace a changed or unsafe plugin entrypoint: ${target}`)
        }
        replaceFile(target, pluginWrite.content)
      }
    }
  }

  ensureProjectTemplate(config, check)
  if (!check) safeDirectory(config.projectRoot, ["docs", ".gvozd", "tasks"], true)
  return result
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
