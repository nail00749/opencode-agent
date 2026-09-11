import { createHash } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser/lib/esm/main.js"

export const PROJECT_TRUST_ENV = "GVOZD_TRUST_PROJECT_CONFIG"

function findRoot(start: string): string {
  let current = resolve(start)
  while (true) {
    if (existsSync(join(current, ".git"))) return realpathSync(current)
    const parent = dirname(current)
    if (parent === current) return realpathSync(resolve(start))
    current = parent
  }
}

function within(base: string, target: string, label: string): void {
  const child = relative(base, target)
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return
  throw new Error(`${label} must stay inside ${base}: ${target}`)
}

function rejectSymlinkComponents(base: string, target: string, label: string): void {
  within(base, target, label)
  const segments = relative(base, target).split(/[\\/]/).filter(Boolean)
  let current = base
  for (const segment of segments) {
    current = join(current, segment)
    if (!existsSync(current)) continue
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} must not contain symlink components: ${current}`)
  }
}

function readJsonc(path: string): { value: Record<string, unknown>; bytes: Buffer } {
  const bytes = readFileSync(path)
  const errors: ParseError[] = []
  const value = parse(bytes.toString("utf8"), errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    const details = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")
    throw new Error(`Invalid JSONC in ${path}${details ? `: ${details}` : ""}`)
  }
  return { value: value as Record<string, unknown>, bytes }
}

function promptFromPatch(patch: unknown): string | undefined {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return undefined
  const prompt = (patch as Record<string, unknown>).prompt
  return typeof prompt === "string" && prompt.length > 0 ? prompt : undefined
}

export interface ProjectTrustInput {
  identity: string
  bytes: Buffer
}

export function collectProjectTrustInputs(projectDirectory: string): { canonicalRoot: string; inputs: ProjectTrustInput[] } {
  const canonicalRoot = findRoot(projectDirectory)
  const layer = join(canonicalRoot, "docs", ".gvozd")
  const rootPath = join(layer, "config.jsonc")
  if (!existsSync(rootPath)) return {
    canonicalRoot,
    inputs: [{ identity: "docs/.gvozd/config.jsonc:<missing>", bytes: Buffer.alloc(0) }],
  }
  rejectSymlinkComponents(canonicalRoot, rootPath, "Project config path")
  const rootStat = lstatSync(rootPath)
  if (!rootStat.isFile() || rootStat.isSymbolicLink()) throw new Error(`Project config must be a regular non-symlink file: ${rootPath}`)
  const root = readJsonc(rootPath)
  const files = new Map<string, Buffer>([[relative(canonicalRoot, rootPath).replaceAll("\\", "/"), root.bytes]])
  const prompts: Array<{ source: string; value: string }> = []
  const inlineAgents = root.value.agents
  if (inlineAgents && typeof inlineAgents === "object" && !Array.isArray(inlineAgents)) {
    for (const patch of Object.values(inlineAgents as Record<string, unknown>)) {
      const prompt = promptFromPatch(patch)
      if (prompt) prompts.push({ source: rootPath, value: prompt })
    }
  }

  const configuredDirectory = root.value.agentsDirectory
  if (configuredDirectory !== undefined && (typeof configuredDirectory !== "string" || configuredDirectory.length === 0)) {
    throw new Error(`Invalid agentsDirectory in ${rootPath}`)
  }
  const agentsDirectory = resolve(layer, (configuredDirectory as string | undefined) ?? "agents")
  within(layer, agentsDirectory, "agentsDirectory")
  if (existsSync(agentsDirectory)) {
    rejectSymlinkComponents(canonicalRoot, agentsDirectory, "agentsDirectory")
    const stat = lstatSync(agentsDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`agentsDirectory must be a regular directory: ${agentsDirectory}`)
    within(realpathSync(layer), realpathSync(agentsDirectory), "agentsDirectory")
    for (const entry of readdirSync(agentsDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.endsWith(".jsonc")) continue
      const path = join(agentsDirectory, entry.name)
      if (!entry.isFile()) throw new Error(`Agent fragment must be a regular non-symlink file: ${path}`)
      rejectSymlinkComponents(canonicalRoot, path, "Agent fragment path")
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Agent fragment must be a regular non-symlink file: ${path}`)
      const fragment = readJsonc(path)
      files.set(relative(canonicalRoot, path).replaceAll("\\", "/"), fragment.bytes)
      const prompt = promptFromPatch(fragment.value)
      if (prompt) prompts.push({ source: path, value: prompt })
    }
  }

  for (const prompt of prompts) {
    const path = resolve(dirname(prompt.source), prompt.value)
    within(layer, path, "Agent prompt")
    rejectSymlinkComponents(canonicalRoot, path, "Agent prompt")
    if (!existsSync(path)) throw new Error(`Agent prompt is missing: ${path}`)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Agent prompt must be a regular non-symlink file: ${path}`)
    const canonical = realpathSync(path)
    within(realpathSync(layer), canonical, "Agent prompt")
    files.set(relative(canonicalRoot, path).replaceAll("\\", "/"), readFileSync(path))
  }
  return {
    canonicalRoot,
    inputs: [...files].map(([identity, bytes]) => ({ identity, bytes })).sort((left, right) => left.identity.localeCompare(right.identity)),
  }
}

export function computeProjectTrustToken(projectDirectory: string): string {
  const collected = collectProjectTrustInputs(projectDirectory)
  const hash = createHash("sha256")
  hash.update("agent-gvozd-project-trust-v1\0")
  hash.update(collected.canonicalRoot)
  hash.update("\0")
  for (const input of collected.inputs) {
    hash.update(String(Buffer.byteLength(input.identity)))
    hash.update(":")
    hash.update(input.identity)
    hash.update(":")
    hash.update(String(input.bytes.length))
    hash.update(":")
    hash.update(input.bytes)
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}
