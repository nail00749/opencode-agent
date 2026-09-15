import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser/lib/esm/main.js"
import { z } from "zod"
import { resolveOpenCodeConfigRoot } from "./config-root"
import type { FileLeaseRole } from "./file-leases"
import { computeProjectTrustToken, PROJECT_TRUST_ENV } from "./project-trust"
import { DEFAULT_ACTIVE_TTL_MS as DEFAULT_LEASE_ACTIVE_TTL_MS, DEFAULT_RESERVATION_TTL_MS as DEFAULT_LEASE_RESERVATION_TTL_MS } from "./file-leases"

export { resolveOpenCodeConfigRoot } from "./config-root"

const permissionSchema = z.object({
  action: z.string().min(1),
  resource: z.string().min(1),
  effect: z.enum(["allow", "ask", "deny"]),
}).strict()

const modelRefSchema = z
  .string()
  .min(1)
  .regex(/^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/, "Expected provider/model or provider/model#variant")

const agentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Expected a filesystem-safe agent ID")

const fileLeaseRoleSchema = z.enum(["coordinator", "writer", "readonly"])

const agentPatchSchema = z.object({
  description: z.string().min(1).optional(),
  mode: z.enum(["primary", "subagent", "all"]).optional(),
  models: z.array(modelRefSchema).min(1).optional(),
  prompt: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).optional(),
  mcp: z.array(z.string().min(1)).optional(),
  permissions: z.array(permissionSchema).optional(),
  fileLease: fileLeaseRoleSchema.optional(),
  disabled: z.boolean().optional(),
}).strict()

const leaseSchema = z.object({
  /** Reservation (unclaimed) lease lifetime in minutes. Default: 5. */
  reservationTtlMinutes: z.number().int().positive().max(24 * 60).optional(),
  /** Active (claimed) lease lifetime in minutes. Default: 30. */
  activeTtlMinutes: z.number().int().positive().max(24 * 60).optional(),
}).strict()

const rootPatchSchema = z.object({
  $schema: z.string().min(1).optional(),
  defaultAgent: agentIdSchema.optional(),
  agentsDirectory: z.string().min(1).optional(),
  agents: z.record(agentIdSchema, agentPatchSchema).optional(),
  lease: leaseSchema.optional(),
}).strict()

const resolvedAgentSchema = agentPatchSchema.extend({
  description: z.string().min(1),
  mode: z.enum(["primary", "subagent", "all"]),
  models: z.array(modelRefSchema).min(1),
  prompt: z.string().min(1),
  skills: z.array(z.string().min(1)),
  mcp: z.array(z.string().min(1)),
  permissions: z.array(permissionSchema),
  fileLease: fileLeaseRoleSchema,
  disabled: z.boolean(),
})

export type PermissionRule = z.infer<typeof permissionSchema>
export type AgentConfig = Omit<z.infer<typeof resolvedAgentSchema>, "fileLease"> & {
  fileLease: FileLeaseRole
  /** Immutable prompt bytes captured while loading the owning config layer. */
  promptContent?: string
}
type AgentPatch = z.infer<typeof agentPatchSchema>
type LoadedAgentPatch = AgentPatch & { promptContent?: string }

export interface LeaseTtlConfig {
  reservationTtlMs: number
  activeTtlMs: number
}

export interface ResolvedConfig {
  defaultAgent: string
  agents: Record<string, AgentConfig>
  lease: LeaseTtlConfig
  packageRoot: string
  projectRoot: string
  projectConfigDirectory: string
  globalConfigDirectory: string
  sources: string[]
}

interface Layer {
  defaultAgent?: string
  agents: Record<string, LoadedAgentPatch>
  lease?: z.infer<typeof leaseSchema>
  sources: string[]
}

const SAFE_UNTRUSTED_AGENT_FIELDS = new Set(["description"])

function assertTrustedProjectPatch(patch: AgentPatch, sourcePath: string, id: string, trusted: boolean, knownAgents: ReadonlySet<string>): void {
  if (trusted) return
  const fields = Object.keys(patch).filter((field) => !SAFE_UNTRUSTED_AGENT_FIELDS.has(field))
  if (fields.length === 0 && knownAgents.has(id)) return
  throw new Error(
    `Untrusted project config ${sourcePath} cannot override ${fields.join(", ") || `unknown agent ${id}`}. `
    + `Set ${PROJECT_TRUST_ENV} to the exact token returned by computeProjectTrustToken() after reviewing these files.`,
  )
}

function readJsonc(path: string): unknown {
  const errors: ParseError[] = []
  const value = parse(readFileSync(path, "utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ")
    throw new Error(`Invalid JSONC in ${path}: ${details}`)
  }
  return value
}

function assertWithin(base: string, target: string, label: string): void {
  const child = relative(base, target)
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return
  throw new Error(`${label} must stay inside ${base}: ${target}`)
}

function resolvePrompt(patch: AgentPatch, sourcePath: string, layerDirectory: string): LoadedAgentPatch {
  if (!patch.prompt) return patch
  const prompt = resolve(dirname(sourcePath), patch.prompt)
  assertWithin(layerDirectory, prompt, "Agent prompt")
  if (!existsSync(prompt)) throw new Error(`Agent prompt is missing: ${prompt}`)
  const promptStat = lstatSync(prompt)
  if (promptStat.isSymbolicLink() || !promptStat.isFile()) throw new Error(`Agent prompt must be a regular non-symlink file: ${prompt}`)
  const canonical = realpathSync(prompt)
  assertWithin(realpathSync(layerDirectory), canonical, "Agent prompt")
  const promptContent = readFileSync(canonical, "utf8")
  return { ...patch, prompt: canonical, promptContent }
}

function loadLayer(directory: string, rootFileName: string, required: boolean, projectPolicy?: { trusted: boolean; knownAgents: ReadonlySet<string> }): Layer {
  const rootPath = join(directory, rootFileName)
  if (!existsSync(rootPath)) {
    if (required) throw new Error(`Required config is missing: ${rootPath}`)
    return { agents: {}, sources: [] }
  }

  const root = rootPatchSchema.parse(readJsonc(rootPath))
  if (projectPolicy && !projectPolicy.trusted) {
    const restricted = ["defaultAgent", "agentsDirectory", "lease"].filter((field) => Object.prototype.hasOwnProperty.call(root, field))
    if (restricted.length > 0) throw new Error(`Untrusted project config ${rootPath} cannot override ${restricted.join(", ")}`)
  }
  const agents: Record<string, LoadedAgentPatch> = {}
  for (const [id, patch] of Object.entries(root.agents ?? {})) {
    if (projectPolicy) assertTrustedProjectPatch(patch, rootPath, id, projectPolicy.trusted, projectPolicy.knownAgents)
    agents[id] = resolvePrompt(patch, rootPath, directory)
  }

  const agentsDirectory = resolve(directory, root.agentsDirectory ?? "agents")
  assertWithin(directory, agentsDirectory, "agentsDirectory")
  if (existsSync(agentsDirectory)) {
    const directoryStat = lstatSync(agentsDirectory)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`agentsDirectory must be a regular directory: ${agentsDirectory}`)
    }
    assertWithin(realpathSync(directory), realpathSync(agentsDirectory), "agentsDirectory")
    for (const entry of readdirSync(agentsDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonc")) continue
      const id = entry.name.slice(0, -".jsonc".length)
      agentIdSchema.parse(id)
      const agentPath = join(agentsDirectory, entry.name)
      const patch = agentPatchSchema.parse(readJsonc(agentPath))
      if (projectPolicy) assertTrustedProjectPatch(patch, agentPath, id, projectPolicy.trusted, projectPolicy.knownAgents)
      agents[id] = mergeAgent(agents[id], resolvePrompt(patch, agentPath, directory))
    }
  }

  return {
    defaultAgent: root.defaultAgent,
    agents,
    lease: root.lease,
    sources: [rootPath],
  }
}

function mergeAgent(base: LoadedAgentPatch | undefined, override: LoadedAgentPatch): LoadedAgentPatch {
  return base ? { ...base, ...override } : { ...override }
}

export function resolveAgentConfig(patch: unknown): AgentConfig {
  const parsed = agentPatchSchema.extend({ promptContent: z.string().optional() }).parse(patch)
  const { promptContent, ...agentPatch } = parsed
  const resolved = resolvedAgentSchema.parse({
    skills: [],
    mcp: [],
    permissions: [],
    fileLease: "readonly",
    disabled: false,
    ...agentPatch,
  })
  return promptContent === undefined ? resolved : { ...resolved, promptContent }
}

function findPackageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url))
  while (true) {
    if (existsSync(join(current, "defaults", "default.jsonc"))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error("Unable to locate agent-gvozd package defaults")
}

export function findProjectRoot(start: string): string {
  let current = resolve(start)
  while (true) {
    const git = join(current, ".git")
    if (existsSync(git)) return current
    const parent = dirname(current)
    if (parent === current) return resolve(start)
    current = parent
  }
}

export interface LoadConfigOptions {
  configRoot?: string
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  home?: string
  includeProject?: boolean
  projectTrustToken?: string
}

export function loadConfig(projectDirectory: string, options: LoadConfigOptions = {}): ResolvedConfig {
  const projectRoot = findProjectRoot(projectDirectory)
  const packageRoot = findPackageRoot()
  const projectConfigDirectory = join(projectRoot, "docs", ".gvozd")
  const globalConfigDirectory = join(
    resolveOpenCodeConfigRoot(options.env, options.platform, options.home, options.configRoot),
    "gvozd",
  )
  const baseLayers = [
    loadLayer(join(packageRoot, "defaults"), "default.jsonc", true),
    loadLayer(globalConfigDirectory, "config.jsonc", false),
  ]
  const knownAgents = new Set(baseLayers.flatMap((layer) => Object.keys(layer.agents)))
  const includeProject = options.includeProject !== false
  const suppliedToken = includeProject
    ? options.projectTrustToken ?? (options.env ?? process.env)[PROJECT_TRUST_ENV]
    : undefined
  const trustProjectConfig = includeProject
    && suppliedToken !== undefined
    && suppliedToken === computeProjectTrustToken(projectRoot)
  const projectLayer = includeProject
    ? loadLayer(projectConfigDirectory, "config.jsonc", false, { trusted: trustProjectConfig, knownAgents })
    : undefined
  if (trustProjectConfig && suppliedToken !== computeProjectTrustToken(projectRoot)) {
    throw new Error("Project configuration changed while its trust token was being validated; review it and compute a new token")
  }
  const layers = [...baseLayers, ...(projectLayer ? [projectLayer] : [])]

  const lease: LeaseTtlConfig = {
    reservationTtlMs: DEFAULT_LEASE_RESERVATION_TTL_MS,
    activeTtlMs: DEFAULT_LEASE_ACTIVE_TTL_MS,
  }
  for (const layer of layers) {
    if (!layer.lease) continue
    if (layer.lease.reservationTtlMinutes !== undefined) {
      lease.reservationTtlMs = layer.lease.reservationTtlMinutes * 60_000
    }
    if (layer.lease.activeTtlMinutes !== undefined) {
      lease.activeTtlMs = layer.lease.activeTtlMinutes * 60_000
    }
  }

  let defaultAgent: string | undefined
  const agents: Record<string, LoadedAgentPatch> = {}
  for (const layer of layers) {
    defaultAgent = layer.defaultAgent ?? defaultAgent
    for (const [id, patch] of Object.entries(layer.agents)) {
      agents[id] = mergeAgent(agents[id], patch)
    }
  }

  if (!defaultAgent) throw new Error("defaultAgent is not configured")
  const resolvedAgents = Object.fromEntries(
    Object.entries(agents).map(([id, patch]) => [
      id,
      (() => {
        const agent = resolveAgentConfig(patch)
        if (agent.promptContent === undefined) throw new Error(`Agent prompt snapshot is missing after configuration load: ${agent.prompt}`)
        return agent
      })(),
    ]),
  )
  const defaultConfig = resolvedAgents[defaultAgent]
  if (!defaultConfig || defaultConfig.disabled || defaultConfig.mode === "subagent") {
    throw new Error(`defaultAgent must reference an enabled primary agent: ${defaultAgent}`)
  }

  return {
    defaultAgent,
    agents: resolvedAgents,
    lease,
    packageRoot,
    projectRoot,
    projectConfigDirectory,
    globalConfigDirectory,
    sources: layers.flatMap((layer) => layer.sources),
  }
}
