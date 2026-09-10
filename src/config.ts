import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import { z } from "zod"

const permissionSchema = z.object({
  action: z.string().min(1),
  resource: z.string().min(1),
  effect: z.enum(["allow", "ask", "deny"]),
})

const modelRefSchema = z
  .string()
  .min(1)
  .regex(/^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/, "Expected provider/model or provider/model#variant")

const agentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Expected a filesystem-safe agent ID")

const agentPatchSchema = z.object({
  description: z.string().min(1).optional(),
  mode: z.enum(["primary", "subagent", "all"]).optional(),
  models: z.array(modelRefSchema).min(1).optional(),
  prompt: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).optional(),
  mcp: z.array(z.string().min(1)).optional(),
  permissions: z.array(permissionSchema).optional(),
  disabled: z.boolean().optional(),
})

const rootPatchSchema = z.object({
  defaultAgent: agentIdSchema.optional(),
  agentsDirectory: z.string().min(1).optional(),
  agents: z.record(agentIdSchema, agentPatchSchema).optional(),
})

const resolvedAgentSchema = agentPatchSchema.extend({
  description: z.string().min(1),
  mode: z.enum(["primary", "subagent", "all"]),
  models: z.array(modelRefSchema).min(1),
  prompt: z.string().min(1),
  skills: z.array(z.string().min(1)),
  mcp: z.array(z.string().min(1)),
  permissions: z.array(permissionSchema),
  disabled: z.boolean(),
})

export type PermissionRule = z.infer<typeof permissionSchema>
export type AgentConfig = z.infer<typeof resolvedAgentSchema>
type AgentPatch = z.infer<typeof agentPatchSchema>

export interface ResolvedConfig {
  defaultAgent: string
  agents: Record<string, AgentConfig>
  projectRoot: string
  projectConfigDirectory: string
  sources: string[]
}

interface Layer {
  defaultAgent?: string
  agents: Record<string, AgentPatch>
  sources: string[]
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

function resolvePrompt(patch: AgentPatch, sourcePath: string, layerDirectory: string): AgentPatch {
  if (!patch.prompt) return patch
  const prompt = resolve(dirname(sourcePath), patch.prompt)
  assertWithin(layerDirectory, prompt, "Agent prompt")
  if (!existsSync(prompt)) throw new Error(`Agent prompt is missing: ${prompt}`)
  const canonical = realpathSync(prompt)
  assertWithin(realpathSync(layerDirectory), canonical, "Agent prompt")
  return { ...patch, prompt: canonical }
}

function loadLayer(directory: string, rootFileName: string, required: boolean): Layer {
  const rootPath = join(directory, rootFileName)
  if (!existsSync(rootPath)) {
    if (required) throw new Error(`Required config is missing: ${rootPath}`)
    return { agents: {}, sources: [] }
  }

  const root = rootPatchSchema.parse(readJsonc(rootPath))
  const agents: Record<string, AgentPatch> = {}
  for (const [id, patch] of Object.entries(root.agents ?? {})) {
    agents[id] = resolvePrompt(patch, rootPath, directory)
  }

  const agentsDirectory = resolve(directory, root.agentsDirectory ?? "agents")
  assertWithin(directory, agentsDirectory, "agentsDirectory")
  if (existsSync(agentsDirectory)) {
    assertWithin(realpathSync(directory), realpathSync(agentsDirectory), "agentsDirectory")
    for (const entry of readdirSync(agentsDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonc")) continue
      const id = entry.name.slice(0, -".jsonc".length)
      agentIdSchema.parse(id)
      const agentPath = join(agentsDirectory, entry.name)
      const patch = agentPatchSchema.parse(readJsonc(agentPath))
      agents[id] = mergeAgent(agents[id], resolvePrompt(patch, agentPath, directory))
    }
  }

  return {
    defaultAgent: root.defaultAgent,
    agents,
    sources: [rootPath],
  }
}

function mergeAgent(base: AgentPatch | undefined, override: AgentPatch): AgentPatch {
  return { ...(base ?? {}), ...override }
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

export function loadConfig(projectDirectory: string): ResolvedConfig {
  const projectRoot = findProjectRoot(projectDirectory)
  const packageRoot = findPackageRoot()
  const projectConfigDirectory = join(projectRoot, "docs", ".gvozd")
  const layers = [
    loadLayer(join(packageRoot, "defaults"), "default.jsonc", true),
    loadLayer(join(homedir(), ".config", "opencode", "gvozd"), "config.jsonc", false),
    loadLayer(projectConfigDirectory, "config.jsonc", false),
  ]

  let defaultAgent: string | undefined
  const agents: Record<string, AgentPatch> = {}
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
      resolvedAgentSchema.parse({
        skills: [],
        mcp: [],
        permissions: [],
        disabled: false,
        ...patch,
      }),
    ]),
  )
  const defaultConfig = resolvedAgents[defaultAgent]
  if (!defaultConfig || defaultConfig.disabled || defaultConfig.mode === "subagent") {
    throw new Error(`defaultAgent must reference an enabled primary agent: ${defaultAgent}`)
  }

  return {
    defaultAgent,
    agents: resolvedAgents,
    projectRoot,
    projectConfigDirectory,
    sources: layers.flatMap((layer) => layer.sources),
  }
}
