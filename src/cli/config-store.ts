import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser/lib/esm/main.js"
import { ALL_AGENT_IDS, DEEP_AGENT_IDS, FAST_AGENT_IDS } from "../core/constants"
import { resolveOpenCodeConfigRoot } from "../core/config"
import { CONFIG_SCHEMA_VERSION } from "../core/release-metadata"
import { hasGeneratedSchemaMarker, isEquivalentLegacySchema } from "../core/constants"
import { assertWriteable, replaceFileAtomic } from "../shared/fs"
import { secureCanonicalPath } from "../shared/secure-path"
import type { ModelProfile } from "./provider-catalog"
import { JevPatchSchema, type JevPatch } from "../core/config"

export { ALL_AGENT_IDS, DEEP_AGENT_IDS, FAST_AGENT_IDS }

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

export function applyJevConfig(source: string, patch: Required<JevPatch>): string {
  assertValidJsonc(source, "global Gvozd config")
  const jev = JevPatchSchema.parse(patch) as Required<JevPatch>
  let updated = source
  for (const key of ["enabled", "provider", "baseUrl", "model", "apiKeyEnv", "allowedAgents"] as const) {
    updated = setJsonc(updated, ["jev", key], jev[key])
  }
  return updated
}

export { resolveOpenCodeConfigRoot }

/**
 * Atomically replaces one managed global file after verifying its snapshot.
 * Used by the agents command to toggle agent disabled flags with the same
 * concurrency discipline as model configuration.
 */
export function writeManagedGlobalFile(path: string, content: string, expected: FileSnapshot): void {
  atomicWrite(path, content, expected)
}

function matchesSnapshot(path: string, expected: FileSnapshot): boolean {
  if (!expected.exists) return !existsSync(path)
  if (!existsSync(path)) return false
  const stat = lstatSync(path)
  return stat.isFile() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino
    && readFileSync(path, "utf8") === expected.bytes
}

function atomicWrite(path: string, content: string, expected: FileSnapshot): void {
  const canonicalPath = secureCanonicalPath(path, "Managed global config path")
  if (canonicalPath !== expected.path) throw new Error(`Global config path changed after preflight: ${path}`)
  mkdirSync(dirname(canonicalPath), { recursive: true, mode: 0o700 })
  if (secureCanonicalPath(canonicalPath, "Managed global config path") !== canonicalPath) throw new Error(`Global config path changed during write: ${path}`)
  assertWriteable(dirname(canonicalPath), "Managed global config directory")
  if (!matchesSnapshot(canonicalPath, expected)) throw new Error(`Refusing to replace concurrently changed file: ${canonicalPath}`)
  replaceFileAtomic(canonicalPath, content)
}

function isRegularFile(path: string): boolean {
  const stat = lstatSync(path)
  return stat.isFile() && !stat.isSymbolicLink()
}

export interface GlobalConfigInput {
  configRoot: string
  profile: ModelProfile
  jev?: Required<JevPatch>
  schemaSource: string
  snapshot?: GlobalConfigSnapshot
}

export interface FileSnapshot {
  readonly path: string
  readonly exists: boolean
  readonly bytes?: string
  readonly dev?: number
  readonly ino?: number
}

export interface GlobalConfigSnapshot {
  readonly configRoot: string
  readonly config: FileSnapshot
  readonly schema: FileSnapshot
}

export interface GlobalConfigResult {
  configPath: string
  schemaPath: string
  config: string
}

function legacySchemaMatches(source: string, generated?: string): boolean {
  try {
    const previous = JSON.parse(source) as Record<string, unknown>
    const previousVersion = previous["x-agent-gvozd-schema-version"] as undefined | number
    if (previous.$comment !== undefined || (previousVersion !== undefined && previousVersion !== CONFIG_SCHEMA_VERSION)) {
      return false
    }
    if (previous.$id !== "https://example.invalid/agent-gvozd.schema.json") return false
    return generated ? isEquivalentLegacySchema(source, generated) : true
  } catch {
    return false
  }
}

export function snapshot(path: string): FileSnapshot {
  if (!existsSync(path)) return Object.freeze({ path, exists: false })
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Managed global config snapshot target is unsafe: ${path}`)
  return Object.freeze({ path, exists: true, bytes: readFileSync(path, "utf8"), dev: stat.dev, ino: stat.ino })
}

export function preflightGlobalConfig(configRoot: string, schemaSource?: string): GlobalConfigSnapshot {
  const canonicalRoot = secureCanonicalPath(configRoot, "OpenCode config root")
  const rootStat = existsSync(canonicalRoot) ? lstatSync(canonicalRoot) : undefined
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    throw new Error(`OpenCode config root is not a safe directory: ${canonicalRoot}`)
  }
  assertWriteable(canonicalRoot, "OpenCode config root")
  const directory = secureCanonicalPath(join(canonicalRoot, "gvozd"), "Global Gvozd directory")
  const directoryStat = existsSync(directory) ? lstatSync(directory) : undefined
  if (directoryStat && (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())) {
    throw new Error(`Global Gvozd path is not a safe directory: ${directory}`)
  }
  assertWriteable(directory, "Global Gvozd directory")
  const configPath = join(directory, "config.jsonc")
  const schemaPath = join(directory, "schema.json")
  if (existsSync(configPath)) {
    if (!isRegularFile(configPath)) throw new Error(`Global Gvozd config is not a safe file: ${configPath}`)
    assertValidJsonc(readFileSync(configPath, "utf8"), configPath)
    assertWriteable(configPath, "Global Gvozd config")
  }
  if (existsSync(schemaPath)) {
    if (!isRegularFile(schemaPath)) throw new Error(`Refusing to overwrite unmanaged Gvozd schema: ${schemaPath}`)
    const schema = readFileSync(schemaPath, "utf8")
    if (!hasGeneratedSchemaMarker(schema) && !legacySchemaMatches(schema, schemaSource)) {
      throw new Error(`Refusing to overwrite unmanaged Gvozd schema: ${schemaPath}`)
    }
    assertWriteable(schemaPath, "Global Gvozd schema")
  }
  return Object.freeze({ configRoot: canonicalRoot, config: snapshot(configPath), schema: snapshot(schemaPath) })
}

export function writeGlobalConfig(input: GlobalConfigInput): GlobalConfigResult {
  const state = input.snapshot ?? preflightGlobalConfig(input.configRoot, input.schemaSource)
  const canonicalRoot = secureCanonicalPath(input.configRoot, "OpenCode config root")
  if (state.configRoot !== canonicalRoot) throw new Error("Global config snapshot belongs to another config root")
  const directory = join(state.configRoot, "gvozd")
  const configPath = join(directory, "config.jsonc")
  const schemaPath = join(directory, "schema.json")
  const base = state.config.exists
    ? state.config.bytes!
    : '{\n  "$schema": "./schema.json",\n  "agents": {}\n}\n'
  if (!hasGeneratedSchemaMarker(input.schemaSource)) {
    throw new Error("Package schema is missing the Gvozd ownership marker")
  }

  const configuredModels = applyModelProfile(base, input.profile)
  const config = input.jev ? applyJevConfig(configuredModels, input.jev) : configuredModels
  assertValidJsonc(input.schemaSource, "package Gvozd schema")
  atomicWrite(schemaPath, input.schemaSource.endsWith("\n") ? input.schemaSource : `${input.schemaSource}\n`, state.schema)
  atomicWrite(configPath, config.endsWith("\n") ? config : `${config}\n`, state.config)
  return { configPath, schemaPath, config }
}
