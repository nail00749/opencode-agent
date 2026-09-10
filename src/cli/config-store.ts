import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser/lib/esm/main.js"
import { resolveOpenCodeConfigRoot } from "../config"
import { GENERATED_PLUGIN_MARKER } from "../constants"
import type { ModelProfile } from "./provider-catalog"

export const FAST_AGENT_IDS = ["back-fast", "front-fast", "review-fast", "researcher", "git", "docs", "verifier"] as const
export const DEEP_AGENT_IDS = ["master", "planner", "back-deep", "front-deep", "review-deep", "debugger", "security", "devops"] as const
export const ALL_AGENT_IDS = [...DEEP_AGENT_IDS, ...FAST_AGENT_IDS, "explorer"] as const

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }

function assertValidJsonc(source: string, label: string): void {
  const errors: ParseError[] = []
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    const details = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")
    throw new Error(`Invalid JSONC in ${label}${details ? `: ${details}` : ""}`)
  }
}

function setJsonc(source: string, path: (string | number)[], value: unknown): string {
  return applyEdits(source, modify(source, path, value, { formattingOptions }))
}

export function applyModelProfile(source: string, profile: ModelProfile): string {
  assertValidJsonc(source, "global Gvozd config")
  let updated = source
  for (const id of FAST_AGENT_IDS) updated = setJsonc(updated, ["agents", id, "models"], profile.fast)
  for (const id of DEEP_AGENT_IDS) updated = setJsonc(updated, ["agents", id, "models"], profile.deep)
  updated = setJsonc(updated, ["agents", "explorer", "models"], profile.agentOverrides.explorer ?? profile.fast)
  return updated
}

export { resolveOpenCodeConfigRoot }

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const descriptor = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(descriptor, content)
    closeSync(descriptor)
    renameSync(temporary, path)
  } catch (error) {
    try { closeSync(descriptor) } catch {}
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function isRegularFile(path: string): boolean {
  const stat = lstatSync(path)
  return stat.isFile() && !stat.isSymbolicLink()
}

export interface GlobalConfigInput {
  configRoot: string
  profile: ModelProfile
  schemaSource: string
}

export interface GlobalConfigResult {
  configPath: string
  schemaPath: string
  config: string
}

export function preflightGlobalConfig(configRoot: string): void {
  const rootStat = existsSync(configRoot) ? lstatSync(configRoot) : undefined
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    throw new Error(`OpenCode config root is not a safe directory: ${configRoot}`)
  }
  const directory = join(configRoot, "gvozd")
  const directoryStat = existsSync(directory) ? lstatSync(directory) : undefined
  if (directoryStat && (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())) {
    throw new Error(`Global Gvozd path is not a safe directory: ${directory}`)
  }
  const configPath = join(directory, "config.jsonc")
  const schemaPath = join(directory, "schema.json")
  if (existsSync(configPath)) {
    if (!isRegularFile(configPath)) throw new Error(`Global Gvozd config is not a safe file: ${configPath}`)
    assertValidJsonc(readFileSync(configPath, "utf8"), configPath)
  }
  if (existsSync(schemaPath) && (!isRegularFile(schemaPath) || !readFileSync(schemaPath, "utf8").includes(GENERATED_PLUGIN_MARKER))) {
    throw new Error(`Refusing to overwrite unmanaged Gvozd schema: ${schemaPath}`)
  }
}

export function writeGlobalConfig(input: GlobalConfigInput): GlobalConfigResult {
  preflightGlobalConfig(input.configRoot)
  const directory = join(input.configRoot, "gvozd")
  const configPath = join(directory, "config.jsonc")
  const schemaPath = join(directory, "schema.json")
  const base = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : '{\n  "$schema": "./schema.json",\n  "agents": {}\n}\n'
  if (!input.schemaSource.includes(GENERATED_PLUGIN_MARKER)) {
    throw new Error("Package schema is missing the Gvozd ownership marker")
  }

  const config = applyModelProfile(base, input.profile)
  assertValidJsonc(input.schemaSource, "package Gvozd schema")
  atomicWrite(schemaPath, input.schemaSource.endsWith("\n") ? input.schemaSource : `${input.schemaSource}\n`)
  atomicWrite(configPath, config.endsWith("\n") ? config : `${config}\n`)
  return { configPath, schemaPath, config }
}
