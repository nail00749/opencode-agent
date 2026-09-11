import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { loadConfig } from "../config"
import { preflightGlobalConfig, writeGlobalConfig } from "./config-store"
import { chooseModelProfile, profileFromAgents, type PromptUI } from "./configure"
import { doctorExitCode, runDoctor, type DoctorReport } from "./doctor"
import { writeManagedAgents } from "./global-sync"
import { findOpenCode, parseOpenCodeVersion, type OpenCodeClient } from "./opencode"
import { parseModels } from "./provider-catalog"
import { PACKAGE_NAME, PACKAGE_SPEC, PACKAGE_VERSION, SUPPORTED_OPENCODE_VERSION } from "../release-metadata"
import { resolveOpenCodeConfigRoot } from "../config-root"
import { redactDiagnostic } from "../runtime-events"
import { withExclusiveFileLock } from "../file-lock"
import type { GlobalConfigSnapshot } from "./config-store"
import { secureCanonicalPath } from "../secure-path"

export interface SetupInput {
  cwd: string
  yes?: boolean
  isTTY?: boolean
  ui?: PromptUI
  findClient?: () => Promise<OpenCodeClient>
  output?: (message: string) => void
  runtimeConfigRoot?: string
}

export interface SetupResult {
  status: "complete" | "cancelled"
  report?: DoctorReport
}

function assertVersion(version: string): void {
  if (parseOpenCodeVersion(version) !== SUPPORTED_OPENCODE_VERSION) {
    throw new Error(`Unsupported OpenCode version. Gvozd ${PACKAGE_VERSION} requires ${SUPPORTED_OPENCODE_VERSION}.`)
  }
}

async function selectProfile(input: SetupInput, client: OpenCodeClient, configRoot: string) {
  const catalog = parseModels(await client.models())
  const config = loadConfig(input.cwd, { configRoot, includeProject: false })
  const hasGlobalConfig = existsSync(join(configRoot, "gvozd", "config.jsonc"))
  return chooseModelProfile({
    catalog,
    ui: input.ui,
    yes: input.yes,
    isTTY: input.isTTY,
    existingProfile: hasGlobalConfig ? profileFromAgents(config.agents, catalog) : undefined,
  })
}

async function confirm(input: SetupInput, message: string): Promise<boolean> {
  if (input.yes) return true
  if (!input.ui) throw new Error("Interactive confirmation requires a TTY")
  const answer = await input.ui.confirm({ message, initialValue: true })
  return typeof answer === "symbol" ? false : answer
}

function sameSnapshot(left: GlobalConfigSnapshot, right: GlobalConfigSnapshot): boolean {
  return left.configRoot === right.configRoot
    && left.config.exists === right.config.exists && left.config.dev === right.config.dev
    && left.config.ino === right.config.ino && left.config.bytes === right.config.bytes
    && left.schema.exists === right.schema.exists && left.schema.dev === right.schema.dev
    && left.schema.ino === right.schema.ino && left.schema.bytes === right.schema.bytes
}

export async function runSetup(input: SetupInput): Promise<SetupResult> {
  const client = await (input.findClient ?? (() => findOpenCode()))()
  const paths = await client.debugPaths()
  if (!paths.config) throw new Error("OpenCode did not report its config path")
  const configRoot = secureCanonicalPath(paths.config, "OpenCode config root")
  preflightGlobalConfig(configRoot)
  const runtimeConfigRoot = input.runtimeConfigRoot ?? resolveOpenCodeConfigRoot()
  assertVersion(await client.version())

  const before = loadConfig(input.cwd, { configRoot, includeProject: false })
  const schemaSource = join(dirname(before.sources[0]!), "schema.json")
  const packagedSchema = readFileSync(schemaSource, "utf8")
  const previewSnapshot = preflightGlobalConfig(configRoot, packagedSchema)
  const preview = writeManagedAgents({ configRoot, agents: before.agents, check: true })
  const profile = await selectProfile(input, client, configRoot)
  if (!profile) return { status: "cancelled" }

  input.output?.([
    `Register ${PACKAGE_SPEC}`,
    `Write ${join(configRoot, "gvozd", "config.jsonc")}`,
    `Write managed agents in ${join(configRoot, "agents")}`,
    ...(preview.removed.length > 0 ? [`Remove ${preview.removed.length} stale or disabled managed agent(s)`] : []),
  ].join("\n"))
  if (!(await confirm(input, "Run setup?"))) return { status: "cancelled" }

  return withExclusiveFileLock(join(configRoot, "gvozd", "setup.lock"), async () => {
    if (secureCanonicalPath(configRoot, "OpenCode config root") !== configRoot) throw new Error("OpenCode config root changed while setup awaited the lock")
    const lockedSchema = readFileSync(schemaSource, "utf8")
    const snapshot = preflightGlobalConfig(configRoot, lockedSchema)
    if (!sameSnapshot(previewSnapshot, snapshot)) throw new Error("Global Gvozd configuration changed while setup awaited confirmation; review and rerun setup")
    const lockedBefore = loadConfig(input.cwd, { configRoot, includeProject: false })
    writeManagedAgents({ configRoot, agents: lockedBefore.agents, check: true })
    const lockedProfile = input.yes ? await selectProfile(input, client, configRoot) : profile
    if (!lockedProfile) throw new Error("Model profile changed while setup awaited the global lock; rerun setup")
    if (!sameSnapshot(snapshot, preflightGlobalConfig(configRoot, lockedSchema))) {
      throw new Error("Global Gvozd configuration changed during locked setup revalidation; review and rerun setup")
    }
    writeManagedAgents({ configRoot, agents: lockedBefore.agents, check: true })
    await client.pluginAdd(PACKAGE_SPEC)
    try {
      writeGlobalConfig({ configRoot, profile: lockedProfile, schemaSource: lockedSchema, snapshot })
      const configured = loadConfig(input.cwd, { configRoot, includeProject: false })
      writeManagedAgents({ configRoot, agents: configured.agents })
      await client.serviceRestart()
      const report = await runDoctor({ client, configRoot, runtimeConfigRoot, cwd: input.cwd })
      return { status: "complete", report }
    } catch (error) {
      const detail = redactDiagnostic(error)
      throw new Error(
        `${PACKAGE_NAME} remains registered, but setup is incomplete: ${detail}. `
        + `Managed files under ${configRoot} may be partially updated; no automatic rollback was attempted because concurrent or user changes cannot be distinguished safely. `
        + "Fix the reported cause, then rerun: gvozd setup",
      )
    }
  })
}

export async function runConfigure(input: SetupInput): Promise<SetupResult> {
  const client = await (input.findClient ?? (() => findOpenCode()))()
  const paths = await client.debugPaths()
  if (!paths.config) throw new Error("OpenCode did not report its config path")
  const configRoot = secureCanonicalPath(paths.config, "OpenCode config root")
  preflightGlobalConfig(configRoot)
  const runtimeConfigRoot = input.runtimeConfigRoot ?? resolveOpenCodeConfigRoot()
  assertVersion(await client.version())
  const config = loadConfig(input.cwd, { configRoot, includeProject: false })
  const schemaSource = join(dirname(config.sources[0]!), "schema.json")
  const packagedSchema = readFileSync(schemaSource, "utf8")
  const previewSnapshot = preflightGlobalConfig(configRoot, packagedSchema)
  const profile = await selectProfile(input, client, configRoot)
  if (!profile || !(await confirm(input, "Apply model configuration?"))) return { status: "cancelled" }
  return withExclusiveFileLock(join(configRoot, "gvozd", "setup.lock"), async () => {
    if (secureCanonicalPath(configRoot, "OpenCode config root") !== configRoot) throw new Error("OpenCode config root changed while configuration awaited the lock")
    const lockedSchema = readFileSync(schemaSource, "utf8")
    const snapshot = preflightGlobalConfig(configRoot, lockedSchema)
    if (!sameSnapshot(previewSnapshot, snapshot)) throw new Error("Global Gvozd configuration changed while configuration awaited confirmation; review and rerun")
    loadConfig(input.cwd, { configRoot, includeProject: false })
    const lockedProfile = input.yes ? await selectProfile(input, client, configRoot) : profile
    if (!lockedProfile) throw new Error("Model profile changed while configuration awaited the global lock; rerun configuration")
    if (!sameSnapshot(snapshot, preflightGlobalConfig(configRoot, lockedSchema))) {
      throw new Error("Global Gvozd configuration changed during locked configuration revalidation; review and rerun")
    }
    writeGlobalConfig({ configRoot, profile: lockedProfile, schemaSource: lockedSchema, snapshot })
    await client.serviceRestart()
    const report = await runDoctor({ client, configRoot, runtimeConfigRoot, cwd: input.cwd })
    return { status: "complete", report }
  })
}

export function setupExitCode(result: SetupResult): 0 | 1 {
  if (result.status === "cancelled") return 0
  return result.report ? doctorExitCode(result.report) : 1
}
